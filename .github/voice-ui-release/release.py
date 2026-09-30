#!/usr/bin/env python3
"""Release checks for the voice-ui-dist release workflow.

lint            workflow JSON on stdin (`yq -o=json`): 40-hex action pins,
                exact proposals-only publish guard, and a contents:write job
                limited to pinned checkout/download-artifact, the default or
                bash shell, and run steps with no Nix
provider-guard  fail while apps still consumes ops source: any roccho-dev/ops
                node in flake.lock or `sources.ops` in the dist manifest
proof           merged-PR proof from GitHub API JSON (pull and its reviews);
                the latest non-dismissed review on the exact head must be Green
acceptance      the acceptance runtime's `nix-store --export` closure: under the
                release asset limit, its root in the native path-info closure
                and the entry inside that root
provenance      provenance for the packaged zip and the acceptance closure
verify          a release directory holds exactly the published set, and its
                digests, provenance and proof agree with one exact SHA
selftest        negative cases for lint, provider-guard, the verdict rule, the
                acceptance closure record and a published set whose provenance
                tree differs from the merged tree
"""
import argparse, copy, hashlib, json, pathlib, re, sys, tempfile

ZIP = 'voice-ui-dist.zip'
# The existing acceptance runtime, as one full `nix-store --export` of its closure.
ACCEPTANCE = 'voice-ui-acceptance-runtime.nix-export'
ACCEPTANCE_ENTRY = 'bin/voice-ui-acceptance-node'
ASSETS = {ZIP, ZIP + '.sha256', ACCEPTANCE, ACCEPTANCE + '.sha256', 'provenance.json', 'merged-pr-proof.json'}
PROVENANCE = 'roccho.voice-ui-dist.release-provenance/2'
ASSET_LIMIT = 2 * 1024 ** 3  # GitHub release assets must be smaller than 2 GiB.
STORE_PATH = re.compile(r'/nix/store/[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+')
NAR_HASH = re.compile(r'sha256[-:][A-Za-z0-9+/=]+')
DIGEST = re.compile(r'[0-9a-f]{64}')
PIN = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$')
NIX = re.compile(r'(?<![\w.-])(?:nix|nix-build|nix-shell|nix-store|nix-env|nix-instantiate)(?![\w.-])')
GREEN = re.compile(r'\bROUND_\d+_GREEN\b')
CORRECTIONS = re.compile(r'\bROUND_\d+_CORRECTIONS\b')
WRITE_USES = {
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
}
SHELLS = {None, 'bash'}
OPS = re.compile(r'(?:github\.com[:/]|github:)roccho-dev/ops(?:\.git)?(?![\w.-])', re.I)
GUARD = {
    "github.event_name == 'workflow_dispatch'",
    'inputs.publish',
    "github.ref == 'refs/heads/proposals'",
    "github.event.repository.default_branch == 'proposals'",
}


def sha256(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write(path, value):
    pathlib.Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def locator(repository, sha, name=ZIP):
    return f'https://github.com/{repository}/releases/download/voice-ui-dist-{sha}/{name}'


def writes(permissions):
    return permissions == 'write-all' or (isinstance(permissions, dict) and permissions.get('contents') == 'write')


def lint_errors(workflow):
    errors = []
    if workflow.get('permissions') != {'contents': 'read'}:
        errors.append('workflow permissions must be exactly contents: read')
    jobs = workflow.get('jobs') or {}
    for name, job in jobs.items():
        for i, step in enumerate(job.get('steps') or []):
            uses = step.get('uses')
            if uses is not None and not PIN.match(uses):
                errors.append(f'{name}[{i}]: action not pinned to a 40-hex commit: {uses}')
    writers = [name for name, job in jobs.items() if writes(job.get('permissions'))]
    if writers != ['publish']:
        errors.append(f'exactly one contents:write job named publish is allowed, found {writers}')
    for name in writers:
        job = jobs[name]
        if job.get('container') or job.get('services'):
            errors.append(f'{name}: contents:write job may not use a container or services')
        for scope, defaults in (('workflow', workflow.get('defaults')), (name, job.get('defaults'))):
            if ((defaults or {}).get('run') or {}).get('shell') not in SHELLS:
                errors.append(f'{scope}: defaults.run.shell must be unset or bash for the contents:write job')
        for i, step in enumerate(job.get('steps') or []):
            if NIX.search(step.get('run') or ''):
                errors.append(f'{name}[{i}]: contents:write job runs Nix')
            if step.get('shell') not in SHELLS:
                errors.append(f'{name}[{i}]: contents:write job step shell must be unset or bash')
            if 'uses' in step and step['uses'] not in WRITE_USES:
                errors.append(f'{name}[{i}]: contents:write job may only use pinned checkout and download-artifact')
        guard = str(job.get('if') or '').strip()
        if set(p.strip() for p in guard.split('&&')) != GUARD or guard.count('&&') != len(GUARD) - 1:
            errors.append(f'{name}: guard must be exactly {" && ".join(sorted(GUARD))}')
        if job.get('needs') not in ('build-test', ['build-test']):
            errors.append(f'{name}: must need build-test so it only publishes bytes built in the same run')
    return errors


def provider_errors(lock, manifest):
    errors = []
    for name, node in (lock.get('nodes') or {}).items():
        for key in ('locked', 'original'):
            ref = node.get(key) or {}
            github = ref.get('owner', '').lower() == 'roccho-dev' and ref.get('repo', '').lower() == 'ops'
            if github or OPS.search(str(ref.get('url') or '')):
                errors.append(f'flake.lock node {name} ({key}) is roccho-dev/ops source')
                break
    if 'ops' in (manifest.get('sources') or {}):
        errors.append('dist manifest still records sources.ops')
    return errors


def closure_errors(record):
    """Structural checks of an acceptance closure record; bytes are checked by the caller."""
    errors = []
    paths = [p.get('path') for p in record.get('closure') or []]
    if not paths or len(set(paths)) != len(paths):
        errors.append('closure is empty or lists a path twice')
    for p in record.get('closure') or []:
        if not STORE_PATH.fullmatch(str(p.get('path'))) or not NAR_HASH.fullmatch(str(p.get('narHash'))) \
                or not isinstance(p.get('narSize'), int) or p['narSize'] <= 0:
            errors.append(f'closure member is not a store path with narHash and narSize: {p}')
    if record.get('root') not in paths:
        errors.append('root is not in its own closure')
    if record.get('entry') != f"{record.get('root')}/{ACCEPTANCE_ENTRY}":
        errors.append('entry is not the runtime entry inside the root')
    if not isinstance(record.get('bytes'), int) or not 0 < record['bytes'] < ASSET_LIMIT:
        errors.append('export size is empty or not under the release asset limit')
    if not DIGEST.fullmatch(str(record.get('sha256'))):
        errors.append('export sha256 is not a hex digest')
    return errors


def acceptance_record(export, root, path_info):
    """The acceptance closure record from the export file and native `nix path-info --json -r` output."""
    info = json.loads(pathlib.Path(path_info).read_text())
    rows = info.items() if isinstance(info, dict) else ((r.get('path'), r) for r in info)  # both Nix JSON shapes
    record = {
        'name': ACCEPTANCE,
        'format': 'nix-store --export',
        'bytes': pathlib.Path(export).stat().st_size,
        'sha256': sha256(export),
        'root': root,
        'entry': f'{root}/{ACCEPTANCE_ENTRY}',
        'closure': sorted(({'path': p, 'narHash': r.get('narHash'), 'narSize': r.get('narSize')} for p, r in rows),
                          key=lambda r: r['path']),
    }
    errors = closure_errors(record)
    if errors:
        raise SystemExit('acceptance closure record failed:\n' + '\n'.join(errors))
    return record


def acceptance(a):
    r = acceptance_record(a.export, a.root, a.path_info)
    print(f"acceptance closure: PASS {len(r['closure'])} paths, {r['bytes']} bytes (limit {ASSET_LIMIT}), sha256 {r['sha256']}")


def lint(a):
    errors = lint_errors(json.load(sys.stdin))
    if errors:
        raise SystemExit('release workflow lint failed:\n' + '\n'.join(errors))
    print('release workflow lint: PASS')


def provider_guard(a):
    errors = provider_errors(json.loads(pathlib.Path(a.lock).read_text()), json.loads(pathlib.Path(a.manifest).read_text()))
    if errors:
        raise SystemExit('apps still consumes ops source:\n' + '\n'.join(errors))
    print('provider guard: PASS')


def green_verdict(reviews, head):
    """URL of the latest non-dismissed review on the exact head, which must be Green.

    Green means the body has exactly one distinct ROUND_<n>_GREEN token and no
    ROUND_<n>_CORRECTIONS token, so a Corrections review that names the future
    Green token does not count. This is verdict evidence, not reviewer
    identity: the token is the only machine-readable signal, and a later
    non-Green review on the same head withdraws it.
    """
    on_head = sorted((r for r in reviews if r.get('commit_id') == head and r.get('submitted_at')
                      and r.get('state') != 'DISMISSED'), key=lambda r: r['submitted_at'])
    if not on_head:
        raise SystemExit('no non-dismissed review recorded on the exact reviewed head')
    latest = on_head[-1]
    body = latest.get('body') or ''
    if len(set(GREEN.findall(body))) != 1 or CORRECTIONS.search(body) or not latest.get('html_url'):
        raise SystemExit('latest review on the exact reviewed head is not a ROUND_n_GREEN verdict')
    return latest['html_url']


def proof(a):
    pr = json.loads(pathlib.Path(a.pr).read_text())
    reviews = json.loads(pathlib.Path(a.reviews).read_text())
    head = pr['head']['sha']
    if not pr.get('merged_at') or pr['base']['ref'] != 'proposals' or pr.get('merge_commit_sha') != a.merge_sha:
        raise SystemExit('source is not an exact merged proposals PR for this SHA')
    verdict = green_verdict(reviews, head)
    if a.head_tree != a.merge_tree:
        raise SystemExit('reviewed tree differs from merge tree; an R re-review of the merge SHA is required')
    write(a.out, {
        'pr_number': pr['number'],
        'r_exact_head_verdict_ref': verdict,
        'merged_at': pr['merged_at'],
        'base': 'proposals',
        'reviewed_head': head,
        'reviewed_tree': a.head_tree,
        'merge_sha': a.merge_sha,
        'merge_tree': a.merge_tree,
    })


def provenance(a):
    z = pathlib.Path(a.zip)
    accept = acceptance_record(a.acceptance_export, a.acceptance_root, a.acceptance_path_info)
    accept['locator'] = locator(a.repository, a.sha, ACCEPTANCE)
    write(a.out, {
        'schema': PROVENANCE,
        'producer': {'repository': a.repository, 'workflow_ref': a.workflow_ref, 'run_id': a.run_id, 'run_attempt': a.run_attempt},
        'source': {'repository': a.repository, 'commit': a.sha, 'tree': a.tree},
        'input_digests': {'flake.lock': sha256(pathlib.Path(a.root) / 'flake.lock')},
        'artifact': {'name': ZIP, 'bytes': z.stat().st_size, 'sha256': sha256(z)},
        'locator': locator(a.repository, a.sha),
        'acceptance': accept,
        'cross_host_bytes_reproducible': False,
    })


def verify(a):
    d = pathlib.Path(a.dir)
    names = {p.name for p in d.iterdir()}
    if names != ASSETS:
        raise SystemExit(f'release set must be exactly {sorted(ASSETS)}, found {sorted(names)}')
    digest = sha256(d / ZIP)
    if (d / (ZIP + '.sha256')).read_text().split() != [digest, ZIP]:
        raise SystemExit('zip sha256 file does not match the zip')
    accept_digest = sha256(d / ACCEPTANCE)
    if (d / (ACCEPTANCE + '.sha256')).read_text().split() != [accept_digest, ACCEPTANCE]:
        raise SystemExit('acceptance sha256 file does not match the export')
    p = json.loads((d / 'provenance.json').read_text())
    q = json.loads((d / 'merged-pr-proof.json').read_text())
    accept = p.get('acceptance') or {}
    checks = {
        'provenance schema': p.get('schema') == PROVENANCE,
        'acceptance digest': accept.get('name') == ACCEPTANCE and accept.get('sha256') == accept_digest
                             and accept.get('bytes') == (d / ACCEPTANCE).stat().st_size,
        'acceptance locator': accept.get('locator') == locator(a.repository, a.sha, ACCEPTANCE),
        'acceptance closure': accept.get('format') == 'nix-store --export' and not closure_errors(accept),
        'provenance source commit': p['source']['commit'] == a.sha,
        'provenance source tree': p['source']['tree'] == q['merge_tree'],
        'provenance repository': p['source']['repository'] == a.repository,
        'provenance digest': p['artifact'] == {'name': ZIP, 'bytes': (d / ZIP).stat().st_size, 'sha256': digest},
        'provenance locator': p['locator'] == locator(a.repository, a.sha),
        'not cross-host reproducible': p['cross_host_bytes_reproducible'] is False,
        'input digests': list(p['input_digests']) == ['flake.lock'] and all(DIGEST.fullmatch(v) for v in p['input_digests'].values()),
        'proof merge sha': q['merge_sha'] == a.sha,
        'proof base': q['base'] == 'proposals',
        'proof trees equal': q['reviewed_tree'] == q['merge_tree'],
        'proof complete': all(q.get(k) for k in ('pr_number', 'r_exact_head_verdict_ref', 'merged_at', 'reviewed_head', 'reviewed_tree', 'merge_tree')),
    }
    failed = [k for k, ok in checks.items() if not ok]
    if failed:
        raise SystemExit('release record mismatch: ' + ', '.join(failed))
    print(f'release set {a.sha}: PASS')


def selftest(a):
    pin = 'actions/checkout@' + 'a' * 40
    good = {
        'permissions': {'contents': 'read'},
        'jobs': {
            'build-test': {'steps': [{'uses': pin}, {'run': 'nix build .#voice-ui-dist'}]},
            'publish': {'needs': 'build-test', 'if': ' && '.join(sorted(GUARD)), 'permissions': {'contents': 'write'},
                        'steps': [{'uses': sorted(WRITE_USES)[0]}, {'run': 'gh release create "$TAG"', 'shell': 'bash'}]},
        },
    }
    assert lint_errors(good) == [], lint_errors(good)
    bad_workflows = [
        lambda w: w['jobs']['build-test']['steps'].__setitem__(0, {'uses': 'actions/checkout@v4'}),
        lambda w: w['jobs']['publish']['steps'].append({'run': 'nix flake check'}),
        lambda w: w['jobs']['publish']['steps'].append({'run': 'ls /nix/store'}),
        lambda w: w['jobs']['publish']['steps'].append({'uses': 'cachix/install-nix-action@' + 'b' * 40}),
        lambda w: w['jobs']['publish'].__setitem__('if', "github.event_name == 'workflow_dispatch' && inputs.publish"),
        lambda w: w['jobs']['publish'].__setitem__('if', w['jobs']['publish']['if'] + ' || true'),
        lambda w: w['jobs']['publish'].pop('needs'),
        lambda w: w.__setitem__('permissions', 'write-all'),
        lambda w: w['jobs']['build-test'].__setitem__('permissions', {'contents': 'write'}),
        lambda w: w['jobs']['publish']['steps'][1].__setitem__('shell', 'nix shell nixpkgs#bash -c bash {0}'),
        lambda w: w['jobs']['publish'].__setitem__('defaults', {'run': {'shell': 'nix develop -c bash {0}'}}),
        lambda w: w.__setitem__('defaults', {'run': {'shell': 'nix-shell --run {0}'}}),
        lambda w: w['jobs']['publish']['steps'].append({'uses': 'actions/github-script@' + 'c' * 40, 'with': {'script': "require('child_process').execSync('nix build')"}}),
    ]
    for mutate in bad_workflows:
        w = copy.deepcopy(good)
        mutate(w)
        assert lint_errors(w), f'lint accepted a bad workflow: {w}'
    clean_lock = {'nodes': {'root': {}, 'ui': {'locked': {'type': 'github', 'owner': 'roccho-dev', 'repo': 'ui'}}}}
    clean_manifest = {'sources': {'apps': 'a' * 40, 'ui': 'b' * 40}}
    assert provider_errors(clean_lock, clean_manifest) == []
    bad_providers = [
        ({'nodes': {'ops': {'locked': {'type': 'github', 'owner': 'roccho-dev', 'repo': 'ops'}}}}, clean_manifest),
        ({'nodes': {'x': {'original': {'type': 'github', 'owner': 'Roccho-Dev', 'repo': 'OPS'}}}}, clean_manifest),
        ({'nodes': {'x': {'locked': {'type': 'git', 'url': 'https://github.com/roccho-dev/ops'}}}}, clean_manifest),
        ({'nodes': {'x': {'locked': {'type': 'git', 'url': 'git+https://github.com/roccho-dev/ops.git?ref=proposals'}}}}, clean_manifest),
        ({'nodes': {'x': {'original': {'type': 'indirect', 'url': 'github:roccho-dev/ops/main'}}}}, clean_manifest),
        (clean_lock, {'sources': {'apps': 'a' * 40, 'ops': 'c' * 40}}),
    ]
    for lock, manifest in bad_providers:
        assert provider_errors(lock, manifest), f'provider guard accepted {lock} {manifest}'
    assert provider_errors({'nodes': {'x': {'locked': {'url': 'https://github.com/roccho-dev/ops-extra'}}}}, clean_manifest) == []
    head = 'a' * 40
    review = lambda body, at, commit=head, state='COMMENTED': {
        'commit_id': commit, 'submitted_at': at, 'body': body, 'html_url': f'u/{at}', 'state': state}
    good_verdicts = [
        [review('Verdict: `ROUND_2_GREEN`.', 't2')],
        [review('ROUND_1_CORRECTIONS', 't1'), review('ROUND_2_GREEN', 't2')],
        [review('ROUND_1_GREEN', 't1', state='DISMISSED'), review('ROUND_2_GREEN', 't2')],
        [review('ROUND_2_GREEN', 't1'), review('ROUND_2_CORRECTIONS', 't2', state='DISMISSED')],
    ]
    for reviews in good_verdicts:
        assert green_verdict(reviews, head) == [r for r in reviews if r['state'] != 'DISMISSED'][-1]['html_url'], reviews
    bad_verdicts = [
        [review('Verdict: `ROUND_1_CORRECTIONS`.', 't1')],
        [review('ROUND_1_GREEN', 't1'), review('ROUND_2_CORRECTIONS', 't2')],
        [],
        [review('ROUND_1_GREEN', 't1', commit='b' * 40)],
        [review('green, looks fine', 't1')],
        [review('ROUND_2_CORRECTIONS; post ROUND_2_GREEN only after CI', 't1')],
        [review('ROUND_3_GREEN. The earlier ROUND_2_CORRECTIONS items are closed.', 't1')],
        [review('ROUND_2_GREEN', 't1', state='DISMISSED')],
        [review('ROUND_1_GREEN then ROUND_2_GREEN', 't1')],
        [review('round_2_green, ROUND_2_GREENISH, xROUND_2_GREEN', 't1')],
    ]
    for reviews in bad_verdicts:
        try:
            green_verdict(reviews, head)
        except SystemExit:
            continue
        raise AssertionError(f'accepted a non-Green verdict: {reviews}')
    root = '/nix/store/' + 'a' * 32 + '-voice-ui-acceptance-node'
    dep = '/nix/store/' + 'b' * 32 + '-nodejs-24'
    good_closure = {'bytes': 1, 'sha256': 'c' * 64, 'root': root, 'entry': f'{root}/{ACCEPTANCE_ENTRY}',
                    'closure': [{'path': p, 'narHash': 'sha256-' + 'd' * 43 + '=', 'narSize': 8} for p in (root, dep)]}
    assert closure_errors(good_closure) == [], closure_errors(good_closure)
    bad_closures = [
        lambda r: r['closure'].pop(0),
        lambda r: r.__setitem__('entry', f'{dep}/{ACCEPTANCE_ENTRY}'),
        lambda r: r.__setitem__('entry', f'{root}/bin/sh'),
        lambda r: r.__setitem__('bytes', ASSET_LIMIT),
        lambda r: r.__setitem__('bytes', 0),
        lambda r: r['closure'].append(dict(r['closure'][1])),
        lambda r: r['closure'][1].__setitem__('path', '/tmp/' + 'b' * 32 + '-nodejs-24'),
        lambda r: r['closure'][1].__setitem__('path', '/nix/store/' + 'e' * 32 + '-nodejs-24'),
        lambda r: r['closure'][1].pop('narHash'),
        lambda r: r['closure'][1].__setitem__('narSize', 0),
        lambda r: r.__setitem__('sha256', 'sha256:' + 'c' * 64),
    ]
    for mutate in bad_closures:
        r = copy.deepcopy(good_closure)
        mutate(r)
        assert closure_errors(r), f'closure check accepted {r}'
    # verify() on a tiny synthetic release set. Its proof is marked NEVER_PUBLISHED: it only
    # exercises the checks and is not a proof, an admission or anything a release carries.
    repo, sha, tree = 'roccho-dev/apps', '1' * 40, '2' * 40
    with tempfile.TemporaryDirectory() as tmp:
        d = pathlib.Path(tmp)
        (d / ZIP).write_bytes(b'zip')
        (d / ACCEPTANCE).write_bytes(b'export')
        for name in (ZIP, ACCEPTANCE):
            (d / (name + '.sha256')).write_text(f'{sha256(d / name)}  {name}\n')
        accept = dict(copy.deepcopy(good_closure), name=ACCEPTANCE, format='nix-store --export', bytes=6,
                      sha256=sha256(d / ACCEPTANCE), locator=locator(repo, sha, ACCEPTANCE))
        prov = {'schema': PROVENANCE, 'source': {'repository': repo, 'commit': sha, 'tree': tree},
                'input_digests': {'flake.lock': 'f' * 64}, 'artifact': {'name': ZIP, 'bytes': 3, 'sha256': sha256(d / ZIP)},
                'locator': locator(repo, sha), 'acceptance': accept, 'cross_host_bytes_reproducible': False}
        write(d / 'merged-pr-proof.json', {
            'pr_number': 1, 'r_exact_head_verdict_ref': 'NEVER_PUBLISHED selftest', 'merged_at': 'NEVER_PUBLISHED',
            'base': 'proposals', 'reviewed_head': '3' * 40, 'reviewed_tree': tree, 'merge_sha': sha, 'merge_tree': tree})
        write(d / 'provenance.json', prov)
        args = argparse.Namespace(dir=tmp, sha=sha, repository=repo)
        verify(args)  # the consistent set passes, so the negative below is not vacuous
        prov['source']['tree'] = '4' * 40
        write(d / 'provenance.json', prov)
        try:
            verify(args)
        except SystemExit as refused:
            assert str(refused) == 'release record mismatch: provenance source tree', refused
        else:
            raise AssertionError('verify accepted a provenance source tree that differs from the merged tree')
    print(json.dumps({'lint': {'positive': 1, 'negative': len(bad_workflows)},
                      'provider_guard': {'positive': 2, 'negative': len(bad_providers)},
                      'verdict': {'positive': len(good_verdicts), 'negative': len(bad_verdicts)},
                      'acceptance_closure': {'positive': 1, 'negative': len(bad_closures)},
                      'release_set': {'positive': 1, 'negative': 1}}))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('lint')
    sub.add_parser('selftest')
    p = sub.add_parser('provider-guard')
    p.add_argument('--lock', required=True)
    p.add_argument('--manifest', required=True)
    p = sub.add_parser('proof')
    for k in ('--pr', '--reviews', '--head-tree', '--merge-sha', '--merge-tree', '--out'):
        p.add_argument(k, required=True)
    p = sub.add_parser('acceptance')
    for k in ('--export', '--root', '--path-info'):
        p.add_argument(k, required=True)
    p = sub.add_parser('provenance')
    for k in ('--zip', '--root', '--repository', '--sha', '--tree', '--workflow-ref', '--run-id', '--run-attempt', '--out',
              '--acceptance-export', '--acceptance-root', '--acceptance-path-info'):
        p.add_argument(k, required=True)
    p = sub.add_parser('verify')
    p.add_argument('dir')
    for k in ('--sha', '--repository'):
        p.add_argument(k, required=True)
    a = ap.parse_args()
    {'lint': lint, 'selftest': selftest, 'provider-guard': provider_guard, 'proof': proof,
     'acceptance': acceptance, 'provenance': provenance, 'verify': verify}[a.cmd](a)


if __name__ == '__main__':
    main()
