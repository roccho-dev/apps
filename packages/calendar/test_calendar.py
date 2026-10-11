"""Browser acceptance tests for the static, database-free family calendar.

Run: python packages/calendar/test_calendar.py
Requires: playwright==1.57.0 and its chromium browser.
"""
import json
import os
import shutil
import tempfile
import threading
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

SOURCE = Path(__file__).parent / 'src'
HOLIDAYS = [
    {'date': '2026-10-12', 'title': 'スポーツの日', 'holiday': True},
    {'date': '2026-11-03', 'title': '文化の日', 'holiday': True},
    {'date': '2026-11-23', 'title': '勤労感謝の日', 'holiday': True},
]
EVENT = {'date': '2026-10-11', 'title': '家族でお出かけ'}


def check(condition, label):
    assert condition, label
    print('PASS:', label, flush=True)


def jsonl(items):
    return ''.join(json.dumps(item, ensure_ascii=False) + '\n' for item in items)


def run(base):
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp)
        shutil.copy2(SOURCE / 'index.html', source / 'index.html')
        shutil.copy2(SOURCE / 'events.jsonl', source / 'events.jsonl')
        class QuietHTTP(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(source), **kwargs)
            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHTTP)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        url = f'http://127.0.0.1:{server.server_port}/'
        offline = os.getenv('CALENDAR_OFFLINE') == '1'
        def navigate(page):
            if not offline:
                page.goto(url)
                return
            page.goto('about:blank')
            content = (source / 'events.jsonl').read_text(encoding='utf-8')
            page.evaluate('(content) => { window.fetch = async () => ({ok:true,text:async()=>content}); }', content)
            page.set_content((source / 'index.html').read_text(encoding='utf-8'))
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, **({"executable_path": os.environ["CHROMIUM_PATH"]} if os.getenv("CHROMIUM_PATH") else {}))
                try:
                    desktop = browser.new_page(viewport={'width': 1200, 'height': 740})
                    desktop.clock.install(time=datetime.fromisoformat('2026-10-11T12:00:00+09:00'))
                    errors = []
                    desktop.on('pageerror', lambda err: errors.append(str(err)))
                    navigate(desktop)
                    desktop.locator('.day').first.wait_for()
                    desktop.wait_for_function("document.querySelector('#d-2026-10-12')?.title.includes('スポーツの日')")
                    check(desktop.locator('.day').count() == 98, '92 calendar days plus aligned week edges')
                    check(desktop.locator('.weekday').all_inner_texts() == ['月','火','水','木','金','土','日'], 'Monday starts the week')
                    check(desktop.locator('#month').inner_text() == '10月', 'minimal month header')
                    check(desktop.locator('#d-2026-10-11').get_attribute('class').find('today-day') >= 0, 'today visibly marked in Japan time')
                    for holiday in HOLIDAYS:
                        cell = desktop.locator('#d-' + holiday['date'])
                        check(cell.locator('.holiday-name').inner_text() == holiday['title'], 'official holiday ' + holiday['date'])
                    check(desktop.locator('.dot').count() == 0, 'published JSONL is only nonprivate holidays')

                    desktop.locator('#d-2026-11-03').click()
                    desktop.wait_for_function("location.hash === '#d-2026-11-03'")
                    desktop.wait_for_timeout(450)
                    check(desktop.locator('#month').inner_text() == '11月', 'month header follows scroll')
                    desktop.locator('#d-2026-12-25').click()
                    desktop.wait_for_function("location.hash === '#d-2026-12-25'")
                    desktop.go_back()
                    desktop.wait_for_function("location.hash === '#d-2026-11-03'")
                    check(True, 'date anchors and browser back')
                    desktop.locator('#today-link').click()
                    desktop.wait_for_function("location.hash === '#d-2026-10-11'")
                    check(True, 'today anchor')

                    desktop.locator('#settings summary').click()
                    desktop.locator('input[name="week-start"][value="0"]').check()
                    check(desktop.locator('.weekday').all_inner_texts() == ['日','月','火','水','木','金','土'], 'Sunday selectable')
                    desktop.locator('#settings summary').click()
                    desktop.locator('input[name="week-start"][value="1"]').check()
                    check(desktop.locator('.weekday').all_inner_texts() == ['月','火','水','木','金','土','日'], 'Monday restorable')

                    # Verify edits update the rendering but do not silently publish.
                    desktop.locator('#settings summary').click()
                    desktop.locator('#edit-open').click()
                    check('スポーツの日' in desktop.locator('#data-input').input_value(), 'edit loads published JSONL')
                    desktop.locator('#data-input').fill(jsonl([EVENT, *HOLIDAYS]))
                    desktop.locator('#editor-preview').click()
                    check(desktop.locator('#d-2026-10-11 .dot').count() == 1, 'JSONL preview updates the day')
                    check(desktop.locator('#unpublished').is_visible(), 'preview explicitly marked unpublished')
                    desktop.locator('#settings summary').click()
                    desktop.locator('#edit-open').click()
                    desktop.locator('#data-input').fill('{broken')
                    desktop.locator('#editor-preview').click()
                    check('1行目' in desktop.locator('#validation').inner_text(), 'invalid JSONL rejected')
                    check(desktop.locator('#d-2026-10-11 .dot').count() == 1, 'invalid JSONL cannot corrupt preview')
                    desktop.locator('#data-input').fill(jsonl([EVENT,*HOLIDAYS]))
                    with desktop.expect_download() as download_info:
                        desktop.locator('#editor-export').click()
                    download = download_info.value
                    exported = Path(tmp) / 'exported.jsonl'
                    download.save_as(exported)
                    check(download.suggested_filename == 'events.jsonl' and exported.read_text() == jsonl([EVENT,*HOLIDAYS]), 'JSONL export round-trip')
                    navigate(desktop) if offline else desktop.reload()
                    desktop.wait_for_function("document.querySelector('#d-2026-10-12')?.title.includes('スポーツの日')")
                    check(desktop.locator('#d-2026-10-11 .dot').count() == 0 and not desktop.locator('#unpublished').is_visible(), 'preview never persisted or published')

                    # Modify ONLY the JSONL, verify the served site changes after reload.
                    (source/'events.jsonl').write_text(jsonl([*HOLIDAYS,EVENT]), encoding='utf-8')
                    navigate(desktop) if offline else desktop.reload()
                    desktop.wait_for_function("!!document.querySelector('#d-2026-10-11 .dot')")
                    check(desktop.locator('#d-2026-10-11').get_attribute('title').endswith(EVENT['title']), 'source JSONL alone controls events')
                    check(not errors, 'no browser script errors')

                    mobile = browser.new_page(viewport={'width': 375, 'height': 667}, is_mobile=True, has_touch=True)
                    mobile.clock.install(time=datetime.fromisoformat('2026-10-11T12:00:00+09:00'))
                    navigate(mobile)
                    mobile.wait_for_function("!!document.querySelector('#d-2026-10-11 .dot')")
                    mobile.evaluate('window.scrollTo(0, 1200)')
                    mobile.wait_for_timeout(350)
                    bounds = mobile.locator('#header').bounding_box()
                    check(bounds is not None and abs(bounds['y']) < 1, 'sticky header on mobile scroll')
                    check(mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal scroll on mobile')
                    mobile.locator('#d-2026-10-11').tap()
                    check(mobile.locator('#day-preview').is_visible() and EVENT['title'] in mobile.locator('#day-preview-text').inner_text(), 'touch shows event details')
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)


if __name__ == '__main__':
    run(SOURCE)
