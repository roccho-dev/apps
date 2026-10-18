// Independent quota-cycle evidence joins. No product imports or provider calls.
// R expression and E interpretation retain different admissions and denominators.
import {createHash} from 'node:crypto';
import {exactKeys as exact,sameValue as same,validRequirements,
 validateQuotaInput,validateQuotaOracle,quotaSchedule,referenceQuota,
 gradeQuotaReady,gradeQuotaOrdinary,summarizeQuotaAxis,QUOTA_METHODS,QUOTA_GENERATIONS,QUOTA_GOAL_POLICIES,QUOTA_COMMITMENTS,quotaRepeatProfile} from './quota-cycle-score.mjs';
import {validFactors,validLiteral,validDecision,readRequirementInspection,readFrontierInspection,
 proposalPolicy,oldInterpretationEligible,normalizeInitialIntent,decodeRequiredSlots,stockDifference,verifierDecision} from './frontier-cycle-score.mjs';
import {FRONTIER_SOURCE_NAMES} from './frontier-cycle-audit.mjs';
export const QUOTA_SOURCE_NAMES=Object.freeze([...FRONTIER_SOURCE_NAMES,'tests/quota-cycle-eval.mjs','tests/quota-cycle-score.mjs','tests/quota-cycle-audit.mjs']);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const providers = ['jev', 'typellm'], counts = () => ({ jev: 0, typellm: 0 });
const countShape = x => exact(x, providers) && providers.every(p => Number.isSafeInteger(x[p]) && x[p] >= 0);
const pair = row => row.id + '/' + row.arm;
const endFields = c => ({ status: c.status ?? null, elapsedMs: c.elapsedMs,
  ...(Object.hasOwn(c, 'response') ? { response: c.response } : {}), ...(Object.hasOwn(c, 'error') ? { error: c.error } : {}) });
const offersOf = parts => parts.map(({ key, purpose, label }) => ({ key, purpose, label }));
const validMissing = rows => Array.isArray(rows) && rows.length <= 3 && rows.every(r => exact(r, ['label', 'kind', 'occurrence'])
  && typeof r.label === 'string' && r.label.trim().length > 0 && r.label.length <= 120
  && ['step', 'decision', 'data', 'start', 'end', 'group'].includes(r.kind) && Number.isSafeInteger(r.occurrence)
  && r.occurrence >= 1 && r.occurrence <= 3) && new Set(rows.map(r => JSON.stringify(r))).size === rows.length
  && rows.every(r => rows.filter(x => x.label === r.label && x.kind === r.kind).map(x => x.occurrence).sort().every((n, i) => n === i + 1));
function jsonLines(bytes) {
  const value = Buffer.from(bytes).toString('utf8');
  if (!value.endsWith('\n') || value.includes('\r') || value.slice(0, -1).split('\n').some(s => !s)) throw Error('JSONL framing');
  return value.slice(0, -1).split('\n').map(s => JSON.parse(s));
}
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(x);
function routeOf(call) {
  const route = call.upstream_route ?? call.route;
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) throw Error('HTTP route');
  const url = new URL(route, 'http://fixture.invalid');
  const key = url.pathname === '/api/parts/check' ? 'method' : url.pathname === '/api/parts/requirements' ? 'generation' : null;
  if (url.hash || [...url.searchParams.keys()].some(k => k !== key) || key !== null && url.searchParams.getAll(key).length !== 1) throw Error('query contract');
  const method = url.searchParams.get('method'), generation = url.searchParams.get('generation');
  if (url.pathname === '/api/parts/check' ? !['literal-v2', 'adaptive-v3'].includes(method)
    : url.pathname === '/api/parts/requirements' ? !['independent', 'dependent'].includes(generation) : url.search) throw Error('dependency route policy');
  if (!['/api/parts/check', '/api/parts/requirements', '/api/parts/verify', '/api/judge'].includes(url.pathname)) throw Error('unexpected API route');
  return { path: url.pathname, method, generation };
}
const inventoryOf = (item, initial, parts) => ({ kind: 'voice-ui.goal.inventory.v1', state: {
  utterance: item.utterance, head: initial.head,
  regions: initial.records.filter(r => r.type === 'region').map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
  edges: initial.records.filter(r => r.type === 'relation').map(({ id, from, to }) => ({ id, from, to })), parts,
} });
function stageRows(stdoutBytes) {
  const rows = [];
  for (const line of Buffer.from(stdoutBytes).toString('utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let value; try { value = JSON.parse(line); } catch { if (line.includes('voice-ui.parts.')) throw Error('malformed stage JSON'); continue; }
    if (['voice-ui.parts.stage.v2', 'voice-ui.parts.stage.v3'].includes(value?.kind)) rows.push(value);
    else if (value?.kind?.startsWith('voice-ui.parts.')) throw Error('unjoined foreign parts stdout');
  }
  const groups = [], ids = new Set();
  for (const row of rows) {
    if (!uuid(row.request_id) || !['G0', 'TYPE_REQUIRED', 'VERIFY_REQUIRED', 'STOCK_DIFF'].includes(row.stage)) throw Error('stage identity');
    const prefix = ['kind', 'request_id', 'stage'];
    const tail = row.stage === 'STOCK_DIFF' ? ['required', 'missing', 'decision']
      : row.valid === false ? ['valid'] : row.stage === 'G0' ? ['valid', 'initial', ...(row.kind === 'voice-ui.parts.stage.v3' ? ['proposal_policy'] : [])]
      : row.stage === 'TYPE_REQUIRED' ? ['valid', 'proposal'] : ['valid', 'required', 'factors'];
    if (!exact(row, [...prefix, ...tail, ...(row.stage === 'TYPE_REQUIRED' ? ['generation'] : [])])
      || row.stage === 'TYPE_REQUIRED' && !['independent', 'dependent'].includes(row.generation)
      || row.stage !== 'STOCK_DIFF' && ![true, false].includes(row.valid)) throw Error('closed stage fields');
    if (!groups.length || groups.at(-1)[0].request_id !== row.request_id) {
      if (ids.has(row.request_id)) throw Error('noncontiguous request stages'); ids.add(row.request_id); groups.push([]);
    }
    groups.at(-1).push(row);
  }
  return { rows, groups };
}
function validateG0(initial, inventory) {
  const state = inventory.state;
  if (!exact(initial, ['decision','factors','literal','observation']) || !validDecision(initial.decision) || !validFactors(initial.factors)
      || !validLiteral(initial.literal, state.utterance) || !exact(initial.observation,['valid','status'])
      || typeof initial.observation.valid !== 'boolean' || !['transcribed','unsupported-syntax'].includes(initial.observation.status)
      || !initial.observation.valid && (initial.literal.recognized || initial.literal.required.length || initial.literal.spans.length)) throw Error('G0 closed factors/literal');
  const normalized = normalizeInitialIntent(initial, state.utterance, state.parts, state.regions.map(r => ({type:'region',...r})));
  if (normalized === null || !same(initial.decision, normalized)) throw Error('independent G0 decision equation');
  return oldInterpretationEligible(initial.factors);
}
function stageCall(call, group) {
  const route = routeOf(call), ok = call.status === 200 && !Object.hasOwn(call, 'error');
  const version3 = route.path === '/api/parts/check' && route.method === 'adaptive-v3';
  if (group.some(r => r.kind !== (version3 ? 'voice-ui.parts.stage.v3' : 'voice-ui.parts.stage.v2'))) throw Error('route/stage version boundary');
  const state = route.path === '/api/parts/verify' ? call.request.inventory : call.request;
  const stages = group.map(x => x.stage), expected = route.path === '/api/parts/requirements' ? ['TYPE_REQUIRED']
    : route.path === '/api/parts/verify' ? ['VERIFY_REQUIRED'] : ['G0', 'TYPE_REQUIRED', 'VERIFY_REQUIRED', 'STOCK_DIFF'];
  if (group.some((x, i) => x.valid === false && i !== group.length - 1)) throw Error('stage after rejected contract');
  if (route.path !== '/api/parts/check') {
    if (group.length > 1 || group.length && stages[0] !== expected[0]) throw Error('direct stage isolation');
  } else if (group.length) {
    if (stages[0] !== 'G0' || new Set(stages).size !== stages.length
        || stages.some((s, i) => i && expected.indexOf(s) <= expected.indexOf(stages[i - 1]))) throw Error('check stage order');
  }
  const g0 = group.find(x => x.stage === 'G0'), typed = group.find(x => x.stage === 'TYPE_REQUIRED'), verified = group.find(x => x.stage === 'VERIFY_REQUIRED');
  const stock = group.find(x => x.stage === 'STOCK_DIFF');
  if (typed && typed.generation !== (route.path === '/api/parts/requirements' ? route.generation : 'dependent')) throw Error('Type URL/stage generation join');
  let eligible = false;
  if (g0?.valid) {
    const oldEligible = validateG0(g0.initial, state), policy = proposalPolicy(g0.initial.factors);
    if (version3 && !same(g0.proposal_policy, policy)) throw Error('independent G0 proposal-policy equation');
    eligible = version3 ? policy.eligible : oldEligible;
  }
  if (route.path === '/api/parts/check' && typed && (route.method !== 'adaptive-v3' || !eligible)) throw Error('unauthorized Type stage');
  if (route.path === '/api/parts/check' && verified && !typed?.valid) throw Error('verification without approved Type stage');
  if (typed?.valid) {
    const decoded = decodeRequiredSlots(typed.proposal?.slots);
    if (!exact(typed.proposal, ['slots', 'required']) || decoded === null || !same(decoded, typed.proposal.required)) throw Error('approved Type slot join');
  }
  if (verified?.valid) {
    if (!validRequirements(verified.required) || !validFactors(verified.factors)) throw Error('verification stage fields');
    if (route.path === '/api/parts/check' && (!typed?.valid || !same(verified.required, typed.proposal.required))) throw Error('verify original full proposal');
    if (route.path === '/api/parts/verify' && !same(verified.required, call.request.required)) throw Error('direct verify proposal');
  }
  if (stock) {
    if (!g0?.valid || typed && !typed.valid || verified && !verified.valid || typed?.valid && !verified) throw Error('stock stage prerequisites');
    const required = typed?.proposal.required ?? g0.initial.literal.required;
    if (!same(stock.required, required) || !same(stock.missing, stockDifference(required, state.state.parts)) || !validDecision(stock.decision)) throw Error('deterministic stock stage');
  }
  if (ok) {
    const response = call.response;
    if (!group.length || !uuid(response?.request_id ?? response?.inspection?.request_id)
        || group[0].request_id !== (response.request_id ?? response.inspection.request_id)) throw Error('successful response/request-id join');
    if (route.path === '/api/parts/requirements') {
      if (!typed?.valid || !exact(response, ['schema', 'request_id', 'slots', 'required']) || response.schema !== 'voice-ui.parts.requirements/2'
          || !same({ slots: response.slots, required: response.required }, typed.proposal)) throw Error('direct required response');
    } else if (route.path === '/api/parts/verify') {
      const derived = verifierDecision(response?.factors);
      if (!verified?.valid || !exact(response, ['schema', 'request_id', 'required', 'factors', 'accepted', 'confidence'])
          || response.schema !== 'voice-ui.parts.verification/2' || !same(response.required, verified.required)
          || !same(response.factors, verified.factors) || !derived || response.accepted !== derived.accepted || response.confidence !== derived.confidence)
        throw Error('direct verification response');
    } else {
      const inspection = version3 ? readFrontierInspection(response?.inspection, state.state.utterance, state.state.parts, state.state.regions.map(r => ({type:'region',...r})))
        : readRequirementInspection(response?.inspection, state.state.utterance, state.state.parts);
      if (!exact(response, ['choice', 'confidence', 'inspection']) || !inspection || response.inspection.mode !== route.method || !stock
          || !same(response.inspection.initial, g0.initial) || version3 && !same(response.inspection.proposal_policy, g0.proposal_policy)
          || !same(response.inspection.proposal, typed?.proposal ?? null)
          || !same(response.inspection.verification, verified?.factors ?? null)
          || !same(stock.decision, { choice: response.choice, confidence: response.confidence })
          || !same(stock.decision, inspection.normalized)) throw Error('check all-stage/body equation');
      if (eligible && route.method === 'adaptive-v3' && (!typed || !verified)) throw Error('missing conditional Type/verifier');
    }
  }
  const min = { jev: Number(Boolean(g0)) + Number(Boolean(verified)), typellm: Number(Boolean(typed)) }, max = { ...min };
  if (!ok) {
    if (!group.length) { if (route.path === '/api/parts/requirements') max.typellm++; else max.jev++; }
    else if (route.path === '/api/parts/check' && !stock && group.at(-1).valid !== false) {
      if (typed?.valid && !verified) max.jev++;
      else if (g0?.valid && !typed && route.method === 'adaptive-v3' && eligible) max.typellm++;
    }
  }
  return Object.fromEntries(providers.map(p => [p, { min: min[p], max: max[p] }]));
}
function partitionStages(groups, calls) {
  const memo = new Map();
  const visit = (at, pos) => {
    const key = at + '/' + pos; if (memo.has(key)) return memo.get(key);
    if (at === calls.length) return { ways: pos === groups.length ? 1 : 0, plan: [], bounds: Object.fromEntries(providers.map(p => [p, { min: 0, max: 0 }])) };
    const call = calls[at], options = call.status === 200 && !call.error ? [1] : [0, 1];
    let answer = null;
    for (const size of options) {
      if (pos + size > groups.length) continue;
      const group = size ? groups[pos] : [];
      let bounds; try { bounds = stageCall(call, group); } catch { continue; }
      const rest = visit(at + 1, pos + size); if (!rest.ways) continue;
      const total = Object.fromEntries(providers.map(p => [p, { min: bounds[p].min + rest.bounds[p].min, max: bounds[p].max + rest.bounds[p].max }]));
      if (!answer) answer = { ways: rest.ways, plan: [group, ...rest.plan], bounds: total };
      else { answer.ways = Math.min(2, answer.ways + rest.ways); for (const p of providers) {
        answer.bounds[p].min = Math.min(answer.bounds[p].min, total[p].min); answer.bounds[p].max = Math.max(answer.bounds[p].max, total[p].max);
      } }
    }
    answer ??= { ways: 0, plan: [], bounds: null }; memo.set(key, answer); return answer;
  };
  return visit(0, 0);
}
export async function auditQuotaRaw({projectionBytes,oracleBytes,rawFiles,bundleBytes,protocol,stdoutBytes,
 assessGoal,assessEdge,replayBytes=null,artifactManifestBytes=null,phaseKind='public',parentProjectionBytes=null,parentOracleBytes=null,repeatProfile=null}){
 const input=decode(projectionBytes),oracle=decode(oracleBytes),bundle=decode(bundleBytes),issues=[];
 validateQuotaInput(input,{phaseKind});validateQuotaOracle(oracle,input);
 const repeat=quotaRepeatProfile(repeatProfile),stamp=(repeat?.commitments??QUOTA_COMMITMENTS)[phaseKind]?.[input.axis];
 if(repeat&&input.axis!=='E')throw Error('repeat is ordinary E only');
 if(!stamp||sha256(projectionBytes)!==stamp.input||sha256(oracleBytes)!==stamp.oracle||input.oracle_sha256!==sha256(oracleBytes)
  ||parentProjectionBytes!==null||parentOracleBytes!==null||!same(bundle.parts,oracle.stock_parts))throw Error('exact quota input/oracle/stock/null-parent binding');
 if(phaseKind==='fresh'&&input.axis==='E'&&(oracle.cases.filter(o=>o.expected_gate==='sufficient').length!==2
  ||oracle.cases.filter(o=>o.expected_gate==='missing').length!==2||oracle.cases.filter(o=>o.expected_intent!=='change').length!==2))throw Error('quota E S2/M2/control2');
 const identity=decode(rawFiles['identity.json']),execution=decode(rawFiles['execution.json']),planned=quotaSchedule(input,{phaseKind}),summary=execution.summary;
 if(identity.schema!=='voice-ui.quota-cycle-execution/1'||identity.axis!==input.axis||identity.inputs_sha256!==sha256(projectionBytes)
  ||identity.bundle_sha256!==sha256(bundleBytes)||!same(identity.case_order,input.cases.map(c=>c.id))
  ||!same(identity.arm_order,planned.map(({id,arm})=>({id,arm})))||!same(identity.methods,QUOTA_METHODS)
  ||!same(identity.generation_policies,QUOTA_GENERATIONS)||!same(identity.goal_parts_policies,QUOTA_GOAL_POLICIES)
  ||!same(Object.keys(identity.source_sha256??{}).sort(),[...QUOTA_SOURCE_NAMES].sort())
  ||Object.values(identity.source_sha256??{}).some(h=>! /^[a-f0-9]{64}$/u.test(h)))issues.push('quota execution identity');
 if(execution.schema!=='voice-ui.quota-cycle-phase/1'||execution.axis!==input.axis||execution.expected_cells!==planned.length
  ||!Array.isArray(summary)||summary.length>planned.length)throw Error('quota terminal plan');
 if(summary.some((s,i)=>!same({axis:s.axis,id:s.id,arm:s.arm,method:s.method,generation_policy:s.generation_policy,goal_parts_policy:s.goal_parts_policy},planned[i])))throw Error('quota consumed schedule/policy');
 const names=['identity.json','execution.json','events.jsonl',...planned.slice(0,summary.length).map(p=>p.id+'-'+p.arm+'.json')];
 if(!same(Object.keys(rawFiles).sort(),names.sort()))issues.push('exact raw snapshot inventory');
 const rows=planned.slice(0,summary.length).map(p=>decode(rawFiles[p.id+'-'+p.arm+'.json']));
 if(rows.some(r=>!Array.isArray(r.calls)))throw Error('closed calls array');
 const operationCalls=rows.flatMap(r=>r.calls.filter(c=>routeOf(c).path!=='/api/judge'));
 const log=stageRows(stdoutBytes),partition=partitionStages(log.groups,operationCalls);
 if(!partition.ways)issues.push('unjoined or inconsistent stage stdout');
 if(input.axis==='R'&&(operationCalls.length||log.rows.length))issues.push('R interpretation/Type operation forbidden');
 let replay=null;
 if(replayBytes!==null){
  if(artifactManifestBytes===null||typeof assessGoal!=='function'||typeof assessEdge!=='function')throw Error('replay dependencies');
  replay=auditQuotaReplayJoin({replayBytes,rawFiles,artifactManifestBytes,assessGoal,assessEdge});
  if(replay.status!=='PASS')issues.push('completed artifact replay join');
 }
 const initials=new Map(),proofs=[],graded=[];
 const external=partition.ways?structuredClone(partition.bounds):Object.fromEntries(providers.map(p=>[p,{min:0,max:0}]));
 const reasons=new Set(['none','not-confident','no-executable-delta','candidate-overflow','budget-requests','budget-time',
  'inventory-not-confident','inventory-ambiguous','inventory-no-change','inventory-unsupported','inventory-unresolved','completion-empty']);
 for(const [index,row]of rows.entries()){
  const plan=planned[index],item=input.cases.find(c=>c.id===plan.id),o=oracle.cases.find(c=>c.id===plan.id),parts=input.axis==='R'?item.parts:bundle.parts;
  const fixed=['schema','axis','id','method','arm','generation_policy','goal_parts_policy','supplied_required','replay_suffix_scope','fixture','utterance','parts','valid_execution','elapsedMs',
   'result','calls','initial_head','initial_log','initial_log_sha256','initial_records','final_head','final_log','final_records','frames','lifecycle'];
  if(!exact(row,fixed)||row.schema!=='voice-ui.quota-cycle-cell/1'||row.axis!==input.axis||row.id!==plan.id||row.arm!==plan.arm
   ||row.method!==plan.method||row.generation_policy!==plan.generation_policy||row.goal_parts_policy!==plan.goal_parts_policy
   ||row.fixture!==item.fixture||row.utterance!==item.utterance||!same(row.parts,parts)
   ||!same(row.supplied_required,input.axis==='R'?item.required:null)||typeof row.valid_execution!=='boolean'||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0
   ||!same(summary[index],{axis:row.axis,id:row.id,arm:row.arm,method:row.method,generation_policy:row.generation_policy,goal_parts_policy:row.goal_parts_policy,valid_execution:row.valid_execution,calls:row.calls.length}))issues.push('cell/input/terminal binding '+pair(row));
  if(!initials.has(row.id)){
   const f=input.fixture_contract,sub=f.fixtures[item.fixture],made=await protocol.createDecisionLog([...f.base_records,...sub.extra_records],f.map_id);
   const pin=await protocol.createDecision(made.head,[{type:'PinRegions',items:[...f.base_pins,...sub.extra_pins]}],made.records);
   initials.set(row.id,(await protocol.appendDecision(made.log,pin.decision)).verified);
  }
  const initial=initials.get(row.id),inventory=inventoryOf(item,initial,parts),op=[],judges=[];
  for(const [n,call]of row.calls.entries()){
   const route=routeOf(call),fields=['id','arm','n','route','request','status','elapsedMs',...(Object.hasOwn(call,'upstream_route')?['upstream_route']:[]),
    ...(Object.hasOwn(call,'response')?['response']:[]),...(Object.hasOwn(call,'error')?['error']:[])];
   if(!exact(call,fields)||call.id!==row.id||call.arm!==row.arm||call.n!==n+1||!Number.isFinite(call.elapsedMs)||call.elapsedMs<0
    ||call.status!==null&&(!Number.isSafeInteger(call.status)||call.status<100||call.status>599)
    ||Object.hasOwn(call,'error')&&call.error!=='http_or_contract_unknown')issues.push('closed HTTP terminal/cell '+pair(row));
   if(route.path==='/api/judge'){
    judges.push(call);external.jev.max++;if(call.status===200&&!call.error)external.jev.min++;
    if(call.route!=='/api/judge'||input.axis==='E'&&call.upstream_route!=='/api/judge'
     ||input.axis==='R'&&call.upstream_route!==undefined&&call.upstream_route!==call.route)issues.push('judge locality');
   }else{
    op.push(call);
    if(input.axis!=='E'||route.path!=='/api/parts/check'||call.route!=='/api/parts/check'
     ||call.upstream_route!=='/api/parts/check?method='+row.method||!same(call.request,inventory))issues.push('original E check/body/method');
   }
  }
  const httpValid=row.calls.every(c=>c.status===200&&!Object.hasOwn(c,'error')&&Object.hasOwn(c,'response'));
  if(row.valid_execution&&(!httpValid||!reasons.has(row.result?.reason)))issues.push('invalid HTTP/stop reason admitted');
  const check=op[0],checkOk=check?.status===200&&!check.error;
  let actualMissing=[],preparations=0,coverage=row.result?.inventory?.coverage,effectiveParts=parts,mechanism=true;
  if(input.axis==='E'){
   if(op.length!==1||row.calls[0]!==check||judges.length>8||row.result?.requests!==1+judges.length
    ||row.result?.inventory?.checks!==1||row.result?.inventory?.completions!==0)issues.push('one check/no completion/finite Goal accounting');
   if(checkOk&&!same(coverage,check.response)||!checkOk&&coverage!==null)issues.push('actual check/result equality');
   preparations=row.result?.inventory?.preparations;actualMissing=row.result?.inventory?.missing;
   const inspected=checkOk?(row.method==='adaptive-v3'?readFrontierInspection(check.response?.inspection,item.utterance,parts,row.initial_records)
    :readRequirementInspection(check.response?.inspection,item.utterance,parts)):null;
   const authorized=inspected!==null&&['sufficient','missing'].includes(coverage?.choice)&&coverage.confidence>=.5;
   const expectedMissing=authorized&&coverage.choice==='missing'?inspected.projected_missing:[];
   if(!same(actualMissing,expectedMissing)||preparations!==(expectedMissing.length?1:0)||!authorized&&judges.length)issues.push('verified materialization/authorization');
   effectiveParts=authorized?referenceQuota(suppliedParts(parts,expectedMissing),inspected.full_required):[];
   if(effectiveParts===null){mechanism=false;issues.push('independent quota equation');effectiveParts=[];}
   if(checkOk&&row.result?.reason?.startsWith('inventory-')){
    const wanted=coverage.choice==='unknown'?'inventory-unresolved':coverage.confidence<.5?'inventory-not-confident'
     :['sufficient','missing'].includes(coverage.choice)?null:'inventory-'+coverage.choice;
    if(row.result.reason!==wanted)issues.push('inventory stop/decision equation');
   }
  }else{
   if(op.length||judges.length>8||row.result?.requests!==judges.length||Object.hasOwn(row.result??{},'inventory'))issues.push('R isolated native Goal accounting');
   effectiveParts=row.arm==='O'?parts:referenceQuota(parts,item.required);
   if(effectiveParts===null){mechanism=false;issues.push('R stable quota equation');effectiveParts=[];}
  }
  let proofIssue=false;
  try{
   const final=await protocol.verifyDecisionLog(row.final_log);
   if(row.initial_log!==initial.log||row.initial_log_sha256!==sha256(initial.log)||row.initial_head!==initial.head||!same(row.initial_records,initial.records)
    ||!row.final_log.startsWith(initial.log)||final.head!==row.final_head||!same(final.records,row.final_records))throw Error('log projection');
   const prefixes=new Map(),lines=row.final_log.trimEnd().split('\n');
   for(let n=initial.decisions.length;n<=lines.length;n++){
    const v=await protocol.verifyDecisionLog(lines.slice(0,n).join('\n')+'\n');prefixes.set(v.head,{n,verified:v});
   }
   if(!Array.isArray(row.result?.trace)||judges.length!==row.result.trace.length)throw Error('trace count');
   let previous=initial.decisions.length;
   for(const [n,trace]of row.result.trace.entries()){
    const prefix=prefixes.get(trace.head),call=judges[n],state=call?.request?.state;
    if(!prefix||prefix.n<previous||!traceMatches(trace,call,input.axis)||state?.utterance!==item.utterance
     ||!same(state.graph,prefix.verified.records.filter(r=>r.type==='region').map(({id,label,parent})=>({id,label,parent})))
     ||!same(state.edges,prefix.verified.records.filter(r=>r.type==='relation').map(({id,from,to})=>({id,from,to})))
     ||!same(state.offers,{parts:offersOf(effectiveParts)})||!judgeRequest(call,prefix.verified,row.result.selected,effectiveParts))throw Error('trace state/answers/actual offered quota');
    previous=prefix.n;
   }
   auditAddedRecords(row,initial,effectiveParts,judges);
  }catch{proofIssue=true;mechanism=false;issues.push('protocol/prefix/trace/quota '+pair(row));}
  proofs.push({id:row.id,method:row.method,arm:row.arm,generation_policy:row.generation_policy,goal_parts_policy:row.goal_parts_policy,
   status:proofIssue?'FAIL':'PASS',initial_head:initial.head,final_head:row.final_head,effective_parts:effectiveParts});
  const allocated=partition.plan?.[operationCalls.indexOf(check)]??[],typeCount=allocated.filter(s=>s.stage==='TYPE_REQUIRED').length;
  let paint={status:'PASS',issues:[],paint:'UNPROVEN'};
  if(typeof assessGoal==='function'&&typeof assessEdge==='function'&&Array.isArray(row.frames)&&row.frames.length)paint=auditFrames(row.frames,row,assessGoal,assessEdge);
  else if(row.valid_execution)issues.push('missing actual paint');
  if(paint.status!=='PASS')issues.push(...paint.issues);
  const l=row.lifecycle,saved=lifecycleEqual(l,row,true)&&l.apply_enabled===(row.final_log!==row.initial_log)
   &&(input.axis!=='R'||l.scope==='NATIVE_SESSION_APPLY_RESTORE_NOT_BROWSER_GOAL'
    &&l.target.stored===row.initial_log&&lifecycleEqual(l.browser_restore,row,false)
    &&l.browser_restore.apply_enabled===false&&l.browser_restore.scope==='KEYLESS_COMPLETED_UI_RESTORE_NOT_BROWSER_GOAL');
  if(row.valid_execution&&!saved)issues.push('native/browser Apply/restore/reload equality '+pair(row));
  const replayCell=replayBytes===null?null:decode(replayBytes).rows.find(r=>r.id===row.id&&r.arm===row.arm);
  const replayPaint=replayCell?auditFrames(replayCell.frames,row,assessGoal,assessEdge):null;
  if(replayPaint&&replayPaint.status!=='PASS')issues.push(...replayPaint.issues);
  const common={initial_records:row.initial_records,final_records:row.final_records,initial_log:row.initial_log,final_log:row.final_log,
   initial_head:row.initial_head,final_head:row.final_head,goal_parts_policy:row.goal_parts_policy,quota_proof_valid:mechanism&&!proofIssue,elapsedMs:row.result?.elapsedMs};
  const grade=input.axis==='R'?gradeQuotaReady({...common,parts:row.parts,supplied_required:row.supplied_required,
   goal_offers:judges.map(c=>c.request.state.offers.parts),selected:row.result?.selected},o)
   :gradeQuotaOrdinary({...common,inspection:coverage?.inspection,decision:coverage&&{choice:coverage.choice,confidence:coverage.confidence},
    preparations,materialized_missing:actualMissing,typellm_sends:typeCount},o,parts);
  graded.push({id:row.id,method:row.method,arm:row.arm,generation_policy:row.generation_policy,goal_parts_policy:row.goal_parts_policy,
   valid_execution:row.valid_execution,grade,paint_status:replayPaint===null?paint.paint:[paint.paint,replayPaint.paint].includes('UNPROVEN')?'UNPROVEN'
    :paint.paint==='PASS'&&replayPaint.paint==='PASS'?'PASS':'UNMET',persisted_raw_equal:saved,
   cell_wall_elapsedMs:row.elapsedMs,goal_elapsedMs:Number.isFinite(row.result?.elapsedMs)?row.result.elapsedMs:null,
   goal_deadline_status:Number.isFinite(row.result?.elapsedMs)&&row.result.elapsedMs>=0?row.result.elapsedMs<=180000?'PASS':'UNMET':'UNPROVEN'});
 }
 issues.push(...auditEvents(rawFiles['events.jsonl'],rows,summary));
 const complete=rows.length===planned.length,allValid=complete&&rows.every(r=>r.valid_execution===true);
 if(!['RECORDED','INVALID'].includes(execution.status)||(execution.status==='RECORDED')!==allValid||execution.invalid_cells!==rows.filter(r=>!r.valid_execution).length)issues.push('terminal validity/denominator');
 const semantic=summarizeQuotaAxis(input.axis,graded,oracle.cases,{phaseKind});
 return{schema:'voice-ui.quota-cycle-raw-audit/1',axis:input.axis,status:issues.length?'FAIL':'PASS',issues,complete,all_valid_execution:allValid,
  consumed:rows.length,planned:planned.length,rows:graded,semantic,phase_kind:phaseKind,inputs_sha256:sha256(projectionBytes),parent_inputs_sha256:null,parent_oracle_sha256:null,
  admissible_for_semantic_claim:issues.length===0&&allValid&&identity.source?.scope!=='SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE',
  external_provider_attempts:Object.fromEntries(providers.map(p=>[p,external[p].min===external[p].max?external[p].min:null])),external_provider_attempt_bounds:external,
  stage_rows:log.rows.length,stage_alignment:!partition.ways?'FAIL':partition.ways===1?'UNIQUE':'AMBIGUOUS_FAILED_OPERATIONS_NO_CELL_STAGE_CLAIM',proofs,replay,
  raw_sha256:Object.fromEntries(Object.entries(rawFiles).map(([n,b])=>[n,sha256(b)])),
  scope:'independent quota offers/protocol/native-or-browser persistence/paint join; fixed producer and actual physical stop remain separately required',CI_LIVE_EXECUTION:'UNPROVEN',currency:'COST_NOT_MEASURED'};
}
function lifecycleEqual(l,row,goal){
 return l?.persistence==='PASS'&&typeof l?.apply_enabled==='boolean'&&l.target?.log===row.final_log&&same(l.target?.records,row.final_records)
  &&(!goal||same(l.target?.goal,row.result))&&['applied','reloaded'].every(k=>l[k]?.log===row.final_log&&l[k]?.stored===row.final_log&&same(l[k]?.records,row.final_records));
}
function judgeRequest(call,prefix,selected,parts){
 const state=call.request?.state,regions=prefix.records.filter(r=>r.type==='region'),ids=new Set(regions.map(r=>r.id));
 const parents=regions.filter(r=>r.kind==='group'&&r.parent!==null).map(({id,label,kind,parent})=>({id,label,kind,parent}));
 const prior=Array.isArray(selected)?selected.filter(s=>ids.has(s.region)):null;
 if(!exact(call.request,['kind','state'])||call.request.kind!=='voice-ui.judge.goal-local-delta.v7'
  ||!exact(state,['utterance','graph','edges','parents','offers','selected','candidates','context','scope','placing'])
  ||!same(state.parents,parents)||!same(state.selected,prior)||state.scope!==null||!exact(state.context,['recent'])||!Array.isArray(state.context.recent)
  ||!Array.isArray(state.candidates)||!state.candidates.length||state.candidates.length>254||new Set(state.candidates.map(c=>c.id)).size!==state.candidates.length)return false;
 const used=new Set((prior??[]).map(s=>s.key));
 return state.candidates.every(c=>typeof c.id==='string'&&(c.action==='add-part'
  ?exact(c,['id','action','part','parent'])&&parts.some(p=>p.key===c.part)&&!used.has(c.part)&&parents.some(p=>p.id===c.parent)
  :c.action==='add-edge'&&exact(c,['id','action','from','to'])&&ids.has(c.from)&&ids.has(c.to)&&c.from!==c.to
   &&!state.edges.some(e=>e.from===c.from&&e.to===c.to)))
  &&(state.placing===null||state.candidates.every(c=>c.action==='add-part'&&c.part===state.placing));
}
export function auditQuotaProviderPhase(bytes,expectedSends,{axis,caseCount,phaseKind='public',repeatProfile=null}){
 const repeat=quotaRepeatProfile(repeatProfile);
 if(repeat&&axis!=='E')throw Error('repeat is ordinary E only');
 if(!['R','E'].includes(axis)||!['public','final'].includes(phaseKind)||caseCount!==(phaseKind==='public'?1:axis==='R'?2:6))throw Error('quota phase scope/count');
 const bounds=Object.fromEntries(providers.map(p=>{const v=expectedSends[p],b=typeof v==='number'?{min:v,max:v}:v;
  if(!exact(b,['min','max'])||!Number.isSafeInteger(b.min)||!Number.isSafeInteger(b.max)||b.min<0||b.max<b.min||b.max>181)throw Error('provider bounds');return[p,b];}));
 const actual=counts();for(const line of Buffer.from(bytes.stderrBytes).toString('utf8').split('\n')){const m=/^provider-send:(jev|typellm):([1-9][0-9]*)$/u.exec(line);if(m)actual[m[1]]++;}
 const report=genericProviderPhase(bytes,actual),config=decode(bytes.configBytes),issues=[...report.issues];
 if(config.stage!==phaseKind||config.axis!==axis||config.case_count!==caseCount||Object.hasOwn(config,'correction_batch'))issues.push('registered phase/axis/count/no correction');
 if((config.repeat_profile??null)!==repeatProfile)issues.push('registered repeat identity');
 const cap=axis==='R'?{jev:16*caseCount,typellm:0}:{jev:19*caseCount,typellm:caseCount},
  start=repeat?.charged_prior??{jev:808,typellm:85},limit=repeat?.cycle_cap??{jev:181,typellm:7},remaining={};
 for(const p of providers){
  if(report.sent[p]<bounds[p].min||report.sent[p]>bounds[p].max)issues.push('provider outside raw bounds '+p);
  if(config.allowances[p]>cap[p]||bounds[p].max>cap[p]||report.prior_charged?.[p]<start[p]
   ||report.prior_charged?.[p]+config.allowances[p]>start[p]+limit[p]||report.charged_at_cutoff[p]>start[p]+limit[p])issues.push('phase/cycle allowance '+p);
  remaining[p]=start[p]+limit[p]-report.charged_at_cutoff[p];
 }
 return{...report,status:issues.length?'FAIL':'PASS',issues,expected_external_bounds:bounds,cycle_start:start,cycle_limit:limit,cycle_remaining:remaining};
}
export function auditQuotaProducerBinding({ identityBytes, runtimeAuditBytes, configBytes, processBytes,
  artifactManifestBytes, workerBytes, providerBytes, protocolEntryBytes, bundleBytes, sourceFiles, auditReferences,
  rawFiles, stdoutBytes, stderrBytes, journalBytes, replayBytes = null, typedProviderBytes = null }, producer) {
  if (producer.schema !== 'voice-ui.quota-cycle-producer/1' || !['R', 'E'].includes(producer.axis)) throw Error('requirements producer schema/axis');
  const identity = decode(identityBytes), runtime = decode(runtimeAuditBytes), config = decode(configBytes);
  const process = decode(processBytes), manifest = decode(artifactManifestBytes), source = identity.source, issues = [];
  const parent = null, repeat = quotaRepeatProfile(producer.repeat_profile ?? null);
  if ((config.repeat_profile ?? null) !== (producer.repeat_profile ?? null)
      || (source?.repeat_profile ?? null) !== (producer.repeat_profile ?? null)) issues.push('producer/config/source repeat identity');
  if (repeat && (producer.axis !== 'E' || config.repeat_profile !== repeat.id || source.repeat_profile !== repeat.id
      || source.extraction_profile !== repeat.extraction_profile || source.typed_provider_entry?.scope !== undefined || typedProviderBytes === null
      || !same(producer.provider_sources, repeat.provider_sources)
      || !same({jev:manifest.sources['jev-provider'],typellm:manifest.sources['typellm-provider']}, repeat.provider_sources)
      || producer.typed_provider_sha256 !== sha256(typedProviderBytes)
      || runtime.typed_provider?.sha256 !== sha256(typedProviderBytes)
      || source.typed_provider_entry?.sha256 !== sha256(typedProviderBytes)
      || source.typed_provider_entry?.path !== runtime.typed_provider?.path
      || manifest.sources['typellm-provider'].entry_sha256 !== sha256(typedProviderBytes)))
    issues.push('repeat formal Jev/Type supply and extraction profile binding');
  if (producer.parent_inputs_sha256 !== parent) issues.push('fixed producer public/fresh parent');
  if (source?.schema !== 'voice-ui.poc.runtime/1' || source.scope !== undefined
      || source?.provider_entry?.scope !== undefined) issues.push('synthetic or unrecognized scope is not live producer evidence');
  const items = { raw_identity_sha256: identityBytes, runtime_audit_sha256: runtimeAuditBytes, config_sha256: configBytes,
    process_sha256: processBytes, artifact_manifest_sha256: artifactManifestBytes, worker_sha256: workerBytes,
    provider_sha256: providerBytes, protocol_sha256: protocolEntryBytes, stdout_sha256: stdoutBytes, stderr_sha256: stderrBytes,
    journal_sha256: journalBytes };
  for (const [name, b] of Object.entries(items)) if (producer[name] !== sha256(b)) issues.push('producer digest ' + name);
  if (producer.replay_sha256 !== (replayBytes === null ? null : sha256(replayBytes))) issues.push('replay fixed digest');
  if (!same(Object.keys(rawFiles).sort(), Object.keys(producer.raw_sha256 ?? {}).sort())) issues.push('fixed raw inventory');
  else for (const [name, digest] of Object.entries(producer.raw_sha256)) if (sha256(rawFiles[name]) !== digest) issues.push('fixed raw digest ' + name);
  if (!Buffer.from(rawFiles['identity.json']).equals(Buffer.from(identityBytes)) || identity.schema !== 'voice-ui.quota-cycle-execution/1'
      || identity.axis !== producer.axis || !same(identity.arm_order, producer.arm_order)
      || !same(identity.generation_policies, QUOTA_GENERATIONS) || !same(producer.generation_policies, QUOTA_GENERATIONS)
      || !same(identity.goal_parts_policies, QUOTA_GOAL_POLICIES) || !same(producer.goal_parts_policies, QUOTA_GOAL_POLICIES)
      || !same(identity.methods, QUOTA_METHODS) || !same(source.heads, producer.heads) || !same(config.heads, source.heads)
      || identity.inputs_sha256 !== producer.inputs_sha256 || producer.inputs_sha256 !== config.input_sha256
      || identity.bundle_sha256 !== producer.bundle_sha256
      || sha256(bundleBytes) !== producer.bundle_sha256 || producer.phase_id !== config.phase_id || config.phase_id !== source.launcher.phase_id
      || config.heads.apps !== runtime.apps_sha || runtime.apps_sha !== source.heads.apps || manifest.sources.apps !== runtime.apps_sha
      || manifest.sources.ui !== source.heads.ui || source.audit_sha256 !== sha256(runtimeAuditBytes)
      || runtime.worker.sha256 !== sha256(workerBytes) || source.worker_entry.sha256 !== sha256(workerBytes)
      || runtime.worker.path !== source.worker_entry.path || runtime.manifest.sha256 !== sha256(artifactManifestBytes)
      || runtime.artifact_root !== source.artifact.root || source.artifact.manifest_sha256 !== sha256(artifactManifestBytes)
      || runtime.provider.sha256 !== sha256(providerBytes) || source.provider_entry.sha256 !== sha256(providerBytes)
      || runtime.provider.path !== source.provider_entry.path || manifest.sources['jev-provider'].entry_sha256 !== sha256(providerBytes)
      || runtime.semantic_map.protocol.sha256 !== sha256(protocolEntryBytes) || source.semantic_map.protocol_sha256 !== sha256(protocolEntryBytes)
      || runtime.semantic_map.root !== source.semantic_map.root || runtime.dev_program.path !== source.launcher.dev_program
      || process.pid !== source.launcher.pid || process.start_ticks !== source.launcher.start_ticks || process.pgid !== process.pid
      || !same(process.allowances, source.launcher.allowances) || !same(config.heads, process.heads) || !same(process.allowances, config.allowances)
      || process.program !== config.program || source.launcher.program !== process.program
      || process.config_sha256 !== sha256(configBytes)) issues.push('source/runtime/process joins');
  if (!same(identity.source_sha256, producer.source_sha256)
      || !same(Object.keys(sourceFiles).sort(), [...QUOTA_SOURCE_NAMES].sort())
      || !same(Object.keys(sourceFiles).sort(), Object.keys(producer.source_sha256 ?? {}).sort())) issues.push('built source inventory');
  else for (const [name, digest] of Object.entries(producer.source_sha256)) if (sha256(sourceFiles[name]) !== digest) issues.push('built source digest ' + name);
  if (!Object.keys(producer.independent_audit_sha256 ?? {}).length
      || !same(Object.keys(auditReferences).sort(), Object.keys(producer.independent_audit_sha256).sort())) issues.push('independent audit inventory');
  else for (const [name, digest] of Object.entries(producer.independent_audit_sha256)) if (sha256(auditReferences[name]) !== digest) issues.push('independent audit digest ' + name);
  return { status: issues.length ? 'FAIL' : 'PASS', issues,
    scope: 'fixed exact-byte producer/source testimony joins; physical observation remains independently referenced', CI_LIVE_EXECUTION: 'UNPROVEN' };
}

function genericProviderPhase({ configBytes, processBytes, stderrBytes, stdoutBytes, journalBytes }, expectedSends) {
  const issues = [], config = decode(configBytes), process = decode(processBytes), events = jsonLines(journalBytes);
  const charged = counts(), pending = new Map(), reservedIds = new Set();
  let ownReserve, ownReconcile, before;
  for (const event of events) {
    if (event.kind === "reserve") {
      if (!providers.includes(event.provider) || event.charge !== 1) throw Error("one_off_charge");
      charged[event.provider]++;
    } else if (event.kind === "phase-reserve") {
      if (!countShape(event.allowances) || providers.some(p => event.allowances[p] > 300)
          || reservedIds.has(event.id) || pending.size || !same(event.prior_charged, charged)
          || providers.some(p => charged[p] + event.allowances[p] > 1000)) throw Error("phase_reservation");
      reservedIds.add(event.id); pending.set(event.id, event.allowances);
      if (event.id === config.phase_id) { ownReserve = event; before = { ...charged }; }
    } else if (event.kind === "phase-reconcile") {
      const limit = pending.get(event.id);
      if (!limit || !countShape(event.sent) || providers.some(p => event.sent[p] > limit[p])) throw Error("phase_reconciliation");
      for (const p of providers) charged[p] += event.sent[p];
      pending.delete(event.id);
      if (event.id === config.phase_id) { if (ownReconcile) throw Error("duplicate_reconciliation"); ownReconcile = event; }
    } else if (event.kind !== "outcome") throw Error("journal_event");
    if (providers.some(p => charged[p] > 1000)) throw Error("whole_run_limit");
  }
  const sent = counts();
  for (const line of Buffer.from(stderrBytes).toString("utf8").split("\n")) {
    const match = /^provider-send:(jev|typellm):([1-9][0-9]*)$/.exec(line);
    if (match) { if (+match[2] !== ++sent[match[1]]) throw Error("provider_send_sequence"); }
    else if (line.startsWith("provider-send:")) throw Error("provider_send_format");
  }
  if (!ownReserve || !ownReconcile || pending.size) issues.push("phase not finally reconciled");
  if (!same(config.allowances, process.allowances) || !same(config.heads, process.heads)
      || config.program !== process.program || config.phase_id !== process.phase_id || process.pgid !== process.pid
      || ownReserve?.config_sha256 !== sha256(configBytes) || process.config_sha256 !== sha256(configBytes)
      || !same(ownReserve?.heads, config.heads) || !same(ownReserve?.allowances, config.allowances)
      || ownReserve?.program !== config.program) issues.push("reservation/config/process binding");
  if (!same(ownReconcile?.sent, sent) || !same(sent, expectedSends) || ownReconcile?.pid !== process.pid
      || ownReconcile?.start_ticks !== process.start_ticks || ownReconcile?.stopped_group_empty !== true
      || ownReconcile?.stderr_sha256 !== sha256(stderrBytes) || ownReconcile?.stdout_sha256 !== sha256(stdoutBytes)
      || providers.some(p => sent[p] > config.allowances[p])) issues.push("send/stop/log binding");
  return { status: issues.length ? "FAIL" : "PASS", issues, phase: config.phase_id, sent, prior_charged: before,
    charged_at_cutoff: charged, journal_sha256: sha256(journalBytes), config_sha256: sha256(configBytes),
    stop_scope: "recorded reconciliation only; independent live PID observation remains an explicit audit reference" };
}


// Source-independent generic Goal proof/event/paint joins retained from R v1 helpers.
function suppliedParts(parts, missing) {
  if (!validMissing(missing)) throw Error('completion row shape');
  const keys = new Set(parts.map(p => p.key)); let next = 0;
  return [...parts, ...missing.map(x => {
    let key; do { key = 'goal-extra-' + ++next; } while (keys.has(key)); keys.add(key);
    return { key, label: x.label, kind: x.kind,
      purpose: `one requested part named ${x.label}, kind ${x.kind}, missing instance ${x.occurrence}` };
  })];
}

function readGoalAnswers(call) {
  const state = call?.request?.state, response = call?.response;
  if (response?.kind !== 'voice-ui.judge.decision.v1' || !response.answers || Array.isArray(response.answers)
      || Object.keys(response.answers).join() !== 'delta') return null;
  const answer = response.answers.delta;
  const options = state?.placing === null
    ? [...new Set((state.candidates ?? []).filter(c => c.action === 'add-part').map(c => 'part:' + c.part)),
      ...(state.candidates ?? []).filter(c => c.action === 'add-edge').map(c => c.id), 'none']
    : [...(state?.candidates ?? []).filter(c => c.action === 'add-part' && c.part === state?.placing).map(c => c.id), 'none'];
  if (answer?.type !== 'choice' || !options.includes(answer.choice) || !Number.isFinite(answer.confidence)
      || answer.confidence < 0 || answer.confidence > 1
      || Object.keys(answer).some(k => !['type', 'choice', 'confidence', 'probabilities'].includes(k))) return null;
  if (answer.probabilities !== undefined && (!answer.probabilities || Array.isArray(answer.probabilities)
      || typeof answer.probabilities !== 'object' || Object.entries(answer.probabilities)
        .some(([k, v]) => !options.includes(k) || typeof v !== 'number' || !Number.isFinite(v)))) return null;
  return { delta: { type: 'choice', choice: answer.choice, confidence: answer.confidence } };
}

function traceMatches(trace, call, axis) {
  const browserEnvelope = call?.response && Object.keys(call.response).every(k => ['kind', 'answers'].includes(k));
  const answers = axis === 'E' && !browserEnvelope ? null : readGoalAnswers(call), ok = call?.status === 200 && !Object.hasOwn(call ?? {}, 'error');
  if (trace.answers !== null) return ok && answers !== null && same(trace.answers, answers) && trace.failure === null;
  if (answers !== null && ok) return false;
  if (axis === 'R') {
    const answered = ok && call.response?.kind === 'voice-ui.judge.decision.v1';
    return trace.failure === (answered ? 'judge-contract' : 'judge-unknown');
  }
  if (ok) return trace.failure === 'judge-contract';
  // The browser timer starts before interception, so its interval cannot be
  // inferred from the interceptor's later, separate elapsed clock.
  return trace.failure === 'judge-failed' || trace.failure === 'judge-timeout' && Object.hasOwn(call ?? {}, 'error');
}

function auditAddedRecords(row, initial, effectiveParts, judges) {
  const oldIds = new Set(initial.records.map(r => r.id)), added = row.final_records.filter(r => !oldIds.has(r.id));
  const regions = added.filter(r => r.type === 'region'), edges = added.filter(r => r.type === 'relation');
  const selected = row.result?.selected;
  if (!Array.isArray(selected)) { if (row.valid_execution || added.length) throw Error('missing selected proof'); return; }
  if (selected.length !== regions.length || new Set(selected.map(s => s.key)).size !== selected.length
      || new Set(selected.map(s => s.region)).size !== selected.length) throw Error('selected/new region multiplicity');
  for (const s of selected) {
    const r = regions.find(r => r.id === s.region), part = effectiveParts.find(p => p.key === s.key);
    if (!s || Object.keys(s).sort().join() !== 'key,parent,region' || !r || !part
        || r.parent !== s.parent || r.label !== part.label || r.kind !== part.kind) throw Error('adopted part binding');
    const supported = judges.some((call, i) => {
      const where = readGoalAnswers(call)?.delta, before = judges[i - 1], what = readGoalAnswers(before)?.delta;
      return call.request.state.placing === s.key && where?.confidence >= 0.5 && what?.confidence >= 0.5 && what.choice === 'part:' + s.key
        && before.request.state.placing === null && row.result.trace[i].head === row.result.trace[i - 1].head
        && call.request.state.candidates.some(c => c.id === where.choice && c.action === 'add-part' && c.part === s.key && c.parent === s.parent);
    });
    if (!supported) throw Error('adopted part without chosen offered delta');
  }
  for (const edge of edges) if (!judges.some(call => {
    const a = readGoalAnswers(call)?.delta;
    return call.request.state.placing === null && a?.confidence >= 0.5 && call.request.state.candidates
      .some(c => c.id === a.choice && c.action === 'add-edge' && c.from === edge.from && c.to === edge.to);
  })) throw Error('adopted edge without chosen offered delta');
}


function auditEvents(bytes, rows, summary) {
  const events = jsonLines(bytes), issues = []; let at = 0, previous = -Infinity;
  for (const e of events) { const time = Date.parse(e.at); if (!Number.isFinite(time) || time < previous) issues.push('event time order'); previous = time; }
  const take = kind => { const e = events[at++]; if (e?.kind !== kind) issues.push('event sequence ' + kind); return e; };
  for (const [index, row] of rows.entries()) {
    const start = take('cell-start');
    if (start?.axis !== row.axis || start?.id !== row.id || start?.method !== row.method || start?.arm !== row.arm
        || start?.generation_policy !== row.generation_policy || start?.goal_parts_policy !== row.goal_parts_policy
        || start?.initial_head !== row.initial_head || start?.initial_log_sha256 !== sha256(row.initial_log)) issues.push('cell start');
    for (const c of row.calls) {
      const a = take('http-start'), b = take('http-end');
      if (a?.axis !== row.axis || a?.method !== row.method || a?.id !== row.id || a?.arm !== row.arm || a?.n !== c.n
          || a?.route !== c.route || a?.upstream_route !== c.upstream_route || !same(a?.request, c.request)
          || b?.id !== row.id || b?.arm !== row.arm || b?.n !== c.n
          || !same(endFields(b ?? {}), endFields(c))) issues.push('HTTP start/end/call join');
    }
    const end = take('cell-end');
    const wanted = summary[index];
    if (!same({ axis: end?.axis, id: end?.id, arm: end?.arm, method: end?.method, generation_policy: end?.generation_policy, goal_parts_policy: end?.goal_parts_policy, valid_execution: end?.valid_execution, calls: end?.calls }, wanted)
        || end?.final_head !== row.final_head) issues.push('cell end');
  }
  if (at !== events.length) issues.push('unjoined events');
  return issues;
}


function auditFrames(frames, raw, assessGoal, assessEdge) {
  const issues = [], regions = raw.final_records.filter(r => r.type === 'region'), edges = raw.final_records.filter(r => r.type === 'relation');
  const groups = regions.filter(r => r.kind === 'group' && r.parent !== null);
  const cameras = ['overview', ...groups.map(r => r.id), ...edges.map(r => r.id)];
  const failures = [];
  if (!Array.isArray(frames) || !same(frames.map(f => f.camera), cameras)) return { status: 'FAIL', issues: ['required E cameras'], paint: 'UNPROVEN' };
  for (const frame of frames.slice(1)) {
    const group = groups.find(r => r.id === frame.camera), edge = edges.find(r => r.id === frame.camera), o = frame.observation;
    const expected = group ? regions.filter(r => r.parent === group.id) : [edge.from, edge.to].map(id => regions.find(r => r.id === id));
    if (o?.identity !== true || o?.association !== 'render-owned-semantic-id' || group && o.container?.id !== group.id
        || edge && (o.edge?.from !== edge.from || o.edge?.to !== edge.to)
        || !same(o?.shapes?.map(s => ({ id: s.id, label: s.rawLabel })), expected.map(s => ({ id: s.id, label: s.label })))) issues.push('E semantic paint association');
    const result = group ? assessGoal(o) : assessEdge(o);
    if (!same(result, frame.assessment)) issues.push('E paint recomputation');
    if (result.status !== 'PASS') failures.push(result.status);
  }
  return { status: issues.length ? 'FAIL' : 'PASS', issues,
    paint: frames.length <= 1 || failures.includes('UNPROVEN') ? 'UNPROVEN' : failures.length ? 'UNMET' : 'PASS' };
}


export function auditQuotaReplayJoin({ replayBytes, rawFiles, artifactManifestBytes, assessGoal, assessEdge }) {
  const receipt = decode(replayBytes), manifest = decode(artifactManifestBytes), issues = [], failures = [];
  const rawNames = Object.keys(rawFiles).filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]*-[OQBC][.]json$/.test(name)).sort();
  const expectedPairs = rawNames.map(name => pair(decode(rawFiles[name]))).sort();
  if (receipt.schema !== "voice-ui.closed-live-log-browser/1" || receipt.scope !== "KEYLESS_CLOSED_LIVE_EVIDENCE_REPLAY"
      || receipt.ci_live_execution !== "UNPROVEN" || !same(receipt.viewport, [1280, 720]) || receipt.deviceScaleFactor !== 1
      || receipt.artifact_manifest_sha256 !== sha256(artifactManifestBytes) || !same(receipt.artifact_sources, manifest.sources)
      || !Array.isArray(receipt.rows) || !same(receipt.rows.map(pair).sort(), expectedPairs)
      || new Set(receipt.rows.map(pair)).size !== expectedPairs.length || !rawNames.length) throw Error("replay_identity_coverage");
  let frames = 0, assessed = 0;
  for (const row of receipt.rows) {
    const name = row.id + "-" + row.arm + ".json", raw = decode(rawFiles[name]);
    if (row.raw_sha256 !== sha256(rawFiles[name]) || row.log_sha256 !== sha256(raw.final_log)) issues.push("replay/raw byte join");
    const regions = raw.final_records.filter(r => r.type === "region"), edges = raw.final_records.filter(r => r.type === "relation");
    const groups = regions.filter(r => r.kind === "group" && r.parent !== null);
    const cameras = ["overview", ...groups.map(r => r.id), ...edges.map(r => r.id)];
    if (!Array.isArray(row.frames) || !same(row.frames.map(f => f.camera), cameras)) { issues.push("replay required cameras"); continue; }
    frames += row.frames.length;
    for (const frame of row.frames.slice(1)) {
      const group = groups.find(r => r.id === frame.camera), edge = edges.find(r => r.id === frame.camera), observation = frame.observation;
      const expectedShapes = group ? regions.filter(r => r.parent === group.id)
        : [edge?.from, edge?.to].map(id => regions.find(r => r.id === id));
      if (observation?.identity !== true || observation?.association !== "render-owned-semantic-id"
          || group && observation.container?.id !== group.id
          || edge && (observation.edge?.from !== edge.from || observation.edge?.to !== edge.to)
          || !same(observation?.shapes?.map(s => ({ id: s.id, label: s.rawLabel })), expectedShapes.map(s => ({ id:s?.id, label:s?.label }))))
        issues.push("replay semantic ID/label join");
      const result = group ? assessGoal(observation) : assessEdge(observation); assessed++;
      if (!same(result, frame.assessment)) issues.push("replay assessment recomputation");
      if (result.status !== "PASS") failures.push({ id: row.id, arm: row.arm, camera: frame.camera, assessment: result });
    }
  }
  const product = failures.some(row => row.assessment.status === "UNPROVEN") ? "UNPROVEN" : failures.length ? "UNMET" : "PASS";
  if (!same(receipt.failures, failures) || receipt.status !== product) issues.push("replay product status join");
  return { status: issues.length ? "FAIL" : "PASS", issues, consumed: receipt.rows.length, frames, assessed_frames: assessed,
    recorded_paint_status: product, replay_sha256: sha256(replayBytes), model_quality_scope: "NONE", CI_LIVE_EXECUTION: "UNPROVEN" };
}

// Whole-cycle process graph; never a substitute for an independent actual PID observation.
export function auditQuotaProcess({records,journalBytes,commitmentBytes,freezeBytes,publicFiles,repeatProfile=null}){
 const repeat=quotaRepeatProfile(repeatProfile),issues=[],commitment=decode(commitmentBytes),freeze=decode(freezeBytes),
  baseline=repeat?.charged_prior??{jev:808,typellm:85},limit=repeat?.cycle_cap??{jev:181,typellm:7};
 if(sha256(commitmentBytes)!==(repeat?.commitment_sha256??'b2aea0ad175e93786b5f566b020204ac7c2f3734b867cb9b53741794a2a401ec')
  ||sha256(freezeBytes)!==(repeat?.freeze_sha256??'ba374d29ff1d4a19d36fb705058b60baa5cbf8e12af81cb2ef2a6ac3342431e0')
  ||!same(commitment.charged_prior,baseline)||!same(commitment.cycle_cap,limit)||!same(commitment.allocated,limit)
  ||commitment.setup_sends!==0||commitment.corrections_max!==0||commitment.retries_max!==0)issues.push('fixed quota preregistration');
 if(!same(Object.keys(publicFiles).sort(),(freeze.copy_allowlist??[]).map(r=>r.name).sort()))issues.push('exact public preregistration inventory');
 for(const row of freeze.copy_allowlist??[])if(!publicFiles[row.name]||sha256(publicFiles[row.name])!==row.sha256||Buffer.byteLength(publicFiles[row.name])!==row.bytes)issues.push('published preregistration byte '+row.name);
 if((commitment.repeat_profile??null)!==repeatProfile)issues.push('registered repeat identity');
 if(!Array.isArray(records)||records.length>(repeat?2:4))throw Error('quota process records');
 const events=jsonLines(journalBytes),text=Buffer.from(journalBytes).toString('utf8'),oldEnd=events.findIndex(e=>e.kind==='phase-reconcile'&&e.id===(repeat?.cutoff_phase_id??'frontier-final-E-20261018'));
 if(oldEnd<0)throw Error('quota previous cycle cutoff absent');
 const prefix=text.split('\n').slice(0,oldEnd+1).join('\n')+'\n';
 if(sha256(prefix)!==(repeat?.baseline_journal_sha256??'ce6896e0b1eb7c3c749b659b36e3ed4467dc133042ace81dd990b9f2e10c28d4'))issues.push('frozen previous cycle cutoff bytes');
 const tail=events.slice(oldEnd+1),reserves=tail.filter(e=>e.kind==='phase-reserve'),reconciles=tail.filter(e=>e.kind==='phase-reconcile'),ids=records.map(r=>r.config?.phase_id);
 if(new Set(ids).size!==ids.length||!same(reserves.map(e=>e.id),ids)||!same(reconciles.map(e=>e.id),ids)
  ||tail.some((e,i)=>e.kind!==(i%2===0?'phase-reserve':'phase-reconcile'))||tail.length!==2*ids.length)issues.push('all ordered reservations/reconciliations indexed once; no setup/correction/retry');
 if(reserves.length&&!same(reserves[0].prior_charged,baseline))issues.push('unchanged quota cumulative baseline');
 const order=repeat?['public/E','final/E']:['public/R','public/E','final/R','final/E'],reserved=counts(),charged={...baseline},seen=new Map(),releases=[];let sourceHead=null;
 const integrity=r=>r&&[r.report?.binding,r.report?.phase,r.report?.raw].every(a=>a?.status==='PASS')&&r.report.raw.complete===true&&r.report.raw.consumed===r.report.raw.planned;
 const publicPass=axis=>{const r=seen.get('public/'+axis),raw=r?.report?.raw;return integrity(r)&&raw.all_valid_execution===true&&raw.semantic?.public_gate==='PASS';};
 for(const [i,r]of records.entries()){
  const{index,config,input,report}=r,kind=index?.phase_kind,axis=index?.axis,key=kind+'/'+axis;
  if(key!==order[i]||(config.repeat_profile??null)!==repeatProfile||config.stage!==kind||config.axis!==axis||input.axis!==axis||config.case_count!==input.cases.length
   ||Object.hasOwn(config,'correction_batch')||Object.hasOwn(index,'correction_batch')){issues.push('single fixed stage graph/no correction');continue;}
  validateQuotaInput(input,{phaseKind:kind==='final'?'fresh':'public'});
  if(sourceHead===null)sourceHead=index.apps_sha;
  if(!/^[a-f0-9]{40}$/u.test(sourceHead)||index.apps_sha!==sourceHead||config.heads.apps!==sourceHead)issues.push('one measured source');
  if([report.binding,report.raw,report.phase].some(a=>a?.status!=='PASS'))issues.push('phase integrity admission');
  if(i&&!integrity(records[i-1]))issues.push('next phase before complete stopped source/accounting integrity');
  const stamp=commitment.files.find(f=>f.axis===axis&&f.visibility===(kind==='public'?'public':'sealed'));
  if(!stamp||config.input_sha256!==stamp.input.sha256||report.raw.inputs_sha256!==stamp.input.sha256||input.oracle_sha256!==stamp.oracle.sha256
   ||config.phase_id!==report.phase.phase||input.parent_inputs_sha256!==null||report.raw.parent_inputs_sha256!==null||report.raw.parent_oracle_sha256!==null)issues.push('exact registered input/oracle/phase/null parent');
  const stage=commitment.stages.find(s=>s.id===(kind==='public'?'public-':'final-')+axis),cap=stage&&{jev:stage.jev,typellm:stage.typellm};
  if(repeat&&stage?.phase_id!==config.phase_id)issues.push('registered repeat phase identity');
  if(!cap||!countShape(config.allowances)||!countShape(report.phase.sent)){issues.push('stage provider shape');continue;}
  for(const p of providers){reserved[p]+=config.allowances[p];charged[p]+=report.phase.sent[p];if(config.allowances[p]>cap[p]||report.phase.sent[p]>config.allowances[p])issues.push('fixed stage allowance '+p);}
  if(!same(reserves[i]?.prior_charged,report.phase.prior_charged)||!same(report.phase.charged_at_cutoff,charged)
   ||!same(reconciles[i]?.sent,report.phase.sent)||!same(reserves[i]?.allowances,config.allowances))issues.push('cumulative phase joins');
  if(!repeat&&key==='public/E'&&!publicPass('R'))issues.push('public E before R quality/evidence gate');
  if(kind==='final'){
   const admitted=(repeat?['E']:['R','E']).every(publicPass);if(!admitted)issues.push('fresh before required same-head public gates');
   releases.push({phase:config.phase_id,apps_sha:sourceHead,admitted,prior_fresh_quality_required:false});
  }
  seen.set(key,r);
 }
 if(providers.some(p=>reserved[p]>limit[p]||charged[p]>baseline[p]+limit[p]))issues.push('unallocated budget used');
 return{schema:'voice-ui.quota-cycle-process/1',status:issues.length?'FAIL':'PASS',issues,
  state:records.length===0?'NOT_MEASURED':records.some(r=>r.index.phase_kind==='final')?'FINAL_RECORDED':'PUBLIC_REGRESSION_ONLY',baseline,indexed_phases:records.length,
  source_head:sourceHead,correction_batches:0,reserved,charged_at_cutoff:charged,releases,
  scope:'integrity/process only; conditional expression and ordinary supplementation are separate; retained fresh quality failures do not block complete stopped-evidence progression'};
}
