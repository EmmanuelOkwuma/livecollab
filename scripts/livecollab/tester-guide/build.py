"""Builds the two tester guides from steps.py.

	python3 scripts/livecollab/tester-guide/build.py ~/Desktop/livecollab-site

writes guide-solo.html and guide-two.html into that folder. It stops with an
error if any command or text block is longer than fits on one line of a
table cell, in print or on screen, because blocks never wrap.
"""

import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import steps as g  # noqa: E402

SHORT_STEPS = 25  # first-section steps in guide-two-print.html, chosen to keep it to 12 printed pages
MAX_BLOCK = 56  # characters that fit one line of a "What to do" cell at 12px mono
DATE = 'October 29, 2026'
VERSION = 'LiveCollab 0.3.4'

ROLE_LABEL = {'you': 'You', 'host': 'Host', 'guest': 'Guest', 'both': 'Both', 'third': 'Third person', 'everyone': 'Everyone'}

CSS = """
:root { color-scheme: dark; --bg:#141414; --text:#ececec; --muted:#a3a3a3; --rule:#333333; --code-bg:#1f1f1f; --code-edge:#3a3a3a; --code-text:#e8e8e8; --btn-bg:#2a2a2a; --btn-edge-hover:#6a6a6a; --line:#7a7a7a; --check:#ececec; --accent:#8ab4f8; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16.5px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 56px 16px 96px; }
h1 { font-size: 34px; line-height: 1.2; margin: 0 0 10px; letter-spacing: -0.01em; }
.byline { color: var(--muted); font-size: 14.5px; margin: 0 0 36px; padding-bottom: 18px; border-bottom: 1px solid var(--rule); }
h2 { font-size: 24px; line-height: 1.3; margin: 64px 0 12px; }
h3 { font-size: 18px; margin: 32px 0 8px; }
p { margin: 0 0 14px; }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
code { font: 0.88em/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
ul.plain { padding-left: 20px; margin: 0 0 14px; }

table.steps { width: 100%; border-collapse: collapse; margin: 18px 0 8px; }
table.steps th { text-align: left; font-size: 12.5px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; padding: 0 12px 8px 0; border-bottom: 1px solid var(--rule); }
table.steps td { vertical-align: top; padding: 18px 12px 22px 0; border-bottom: 1px solid var(--rule); }
table.steps tbody { break-inside: avoid; page-break-inside: avoid; }
col.n { width: 52px; } col.do { width: 62%; }
td.n { font-size: 30px; font-weight: 700; line-height: 1; padding-top: 20px; font-variant-numeric: tabular-nums; }
.title { font-weight: 700; font-size: 17.5px; margin: 0 0 8px; line-height: 1.35; }
ol.do { margin: 0; padding: 0; list-style: none; }
ol.do > li { margin: 0 0 10px; }
.who { font-weight: 700; font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 6px; }
.see p { margin: 0 0 8px; }
.see .who { display: block; margin: 0 0 1px; }
.see .none { color: var(--muted); }
.write { margin: 10px 0 0; }
.write label { font-weight: 400; font-size: 15px; display: block; margin-bottom: 4px; }
.ruled { position: relative; margin-top: 2px; }
.ruled .lines i { display: block; height: 28px; border-bottom: 1px solid var(--line); }
.ruled textarea { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; border: 0; padding: 0 2px; background: transparent; resize: none; overflow: auto; font: inherit; font-size: 15px; line-height: 28px; color: var(--text); }
textarea:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
.ticks { margin-top: 12px; font-size: 14.5px; display: flex; flex-wrap: wrap; gap: 6px 16px; }
.ticks label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
input[type=checkbox] { width: 17px; height: 17px; margin: 0; accent-color: var(--check); flex: none; }

.block { margin: 8px 0 4px; border: 1px solid var(--code-edge); border-radius: 6px; background: var(--code-bg); }
.block .bar { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--muted); padding: 4px 6px 0 10px; text-transform: uppercase; letter-spacing: 0.05em; }
.block button { font: 600 12px/1 -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text); background: var(--btn-bg); border: 1px solid var(--code-edge); border-radius: 4px; padding: 5px 9px; cursor: pointer; text-transform: none; letter-spacing: 0; }
.block button:hover { border-color: var(--btn-edge-hover); }
.block pre { margin: 0; padding: 4px 10px 9px; overflow-x: auto; white-space: pre; font: 12px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--code-text); }

.form .field { margin: 0 0 22px; break-inside: avoid; page-break-inside: avoid; }
.form .field > label, .form .field > .label { display: block; font-weight: 600; margin-bottom: 4px; }
.form input[type=text] { width: 100%; border: 0; border-bottom: 1px solid var(--line); font: inherit; padding: 4px 2px; background: transparent; color: var(--text); }
.form .ticks { margin-top: 4px; font-size: 16px; }
.results { break-before: page; page-break-before: always; }
.note { border-left: 3px solid var(--text); padding: 2px 0 2px 14px; margin: 18px 0; }

@media (max-width: 640px) {
	main { padding-top: 32px; }
	table.steps, table.steps tbody, table.steps tr, table.steps td { display: block; width: 100%; }
	table.steps thead { display: none; }
	table.steps tbody { border-bottom: 1px solid var(--rule); padding: 12px 0 18px; }
	table.steps td { border: 0; padding: 4px 0; }
	td.n { padding-top: 6px; }
	td.should::before { content: "What should happen"; display: block; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 10px 0 4px; }
}

@page { size: letter; margin: 14mm 13mm 16mm; }
@media print {
	:root { color-scheme: light; --bg:#fff; --text:#000; --muted:#444; --rule:#cfcfcf; --code-bg:#fff; --code-edge:#777; --code-text:#000; --line:#888; --check:#000; --accent:#000; }
	body { font-size: 10.5pt; line-height: 1.45; color: #000; background: #fff; }
	main { max-width: none; padding: 0; }
	a { color: #000; }
	h2 { margin-top: 0; break-before: page; page-break-before: always; break-after: avoid; }
	h2.first { break-before: auto; page-break-before: auto; margin-top: 28px; }
	.block .bar { display: none; }
	.block { margin: 4px 0 2px; }
	.block pre { font-size: 9pt; overflow: visible; padding: 4px 8px; }
	ol.do > li { margin-bottom: 6px; }
	.title { margin-bottom: 4px; }
	code { background: none; padding: 0; }
	.ruled textarea { overflow: hidden; }
	table.steps td { padding: 10px 10px 12px 0; }
	td.n { font-size: 22pt; }
	.noprint { display: none; }
}
"""

JS = """
(function () {
	var key = 'lc-guide:' + location.pathname.split('/').pop() + ':';
	function get(id) { try { return localStorage.getItem(key + id); } catch (e) { return null; } }
	function set(id, v) { try { localStorage.setItem(key + id, v); } catch (e) { } }
	document.querySelectorAll('input[type=checkbox][id], textarea[id], input[type=text][id]').forEach(function (el) {
		var v = get(el.id);
		if (el.type === 'checkbox') { if (v === '1') { el.checked = true; } el.addEventListener('change', function () { set(el.id, el.checked ? '1' : '0'); }); }
		else { if (v !== null) { el.value = v; } el.addEventListener('input', function () { set(el.id, el.value); }); }
	});
	document.querySelectorAll('.block button').forEach(function (b) {
		b.addEventListener('click', function () {
			var text = b.closest('.block').querySelector('code').textContent;
			function done() { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); }
			if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, fallback); } else { fallback(); }
			function fallback() { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { } document.body.removeChild(t); }
		});
	});
	// Export: every ticked box and written answer as plain text, to paste into a message.
	function exportText() {
		var out = [document.title + ' - ' + location.href, ''];
		document.querySelectorAll('table.steps tbody').forEach(function (tb) {
			var n = tb.querySelector('td.n'); var t = tb.querySelector('.title');
			var ticks = [].slice.call(tb.querySelectorAll('input[type=checkbox]:checked')).map(function (c) { return c.parentNode.textContent.trim(); });
			var w = tb.querySelector('textarea'); var said = w && w.value.trim();
			if (!ticks.length && !said) { return; }
			out.push((n ? n.textContent.trim() + '. ' : '') + (t ? t.textContent.trim() : 'Before anyone leaves') + ': ' + (ticks.join(', ') || '(no box ticked)'));
			if (said) { out.push('   ' + said.replace(/\\n/g, '\\n   ')); }
		});
		var form = document.querySelector('.results');
		if (form) {
			out.push('', 'RESULTS');
			form.querySelectorAll('.field').forEach(function (f) {
				var label = (f.querySelector('label[for], .label') || {}).textContent || '';
				var ticks = [].slice.call(f.querySelectorAll('input[type=checkbox]:checked')).map(function (c) { return c.parentNode.textContent.trim(); });
				var v = f.querySelector('input[type=text], textarea'); var val = v ? v.value.trim() : ticks.join(', ');
				out.push(label.trim() + ': ' + (val || '-'));
			});
		}
		return out.join('\\n');
	}
	var exp = document.getElementById('export-answers');
	if (exp) {
		exp.addEventListener('click', function () {
			var text = exportText(); var box = document.getElementById('export-text');
			box.value = text; box.style.display = 'block'; box.select();
			function done() { exp.textContent = 'Copied: paste it into a message'; setTimeout(function () { exp.textContent = 'Export my answers'; }, 2500); }
			if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { }); }
		});
	}
	var clear = document.getElementById('clear-answers');
	if (clear) { clear.addEventListener('click', function () { if (!confirm('Clear every tick and answer on this page?')) { return; } document.querySelectorAll('input[type=checkbox][id], textarea[id], input[type=text][id]').forEach(function (el) { if (el.type === 'checkbox') { el.checked = false; } else { el.value = ''; } try { localStorage.removeItem(key + el.id); } catch (e) { } }); }); }
})();
"""


def ruled(tid, rows):
	"""A write-in area: real rule lines (they print) under a transparent textarea (typing shows on them)."""
	return f'<div class="ruled"><div class="lines">{"<i></i>" * rows}</div><textarea id="{tid}" rows="{rows}"></textarea></div>'


def block(b):
	if len(b.text) > MAX_BLOCK:
		sys.exit(f'build.py: block longer than {MAX_BLOCK} characters ({len(b.text)}), it would not fit one line: {b.text}')
	label = 'In Terminal' if b.kind == 'term' else 'Type or paste'
	return f'<div class="block"><div class="bar"><span>{label}</span><button type="button">Copy</button></div><pre><code>{html.escape(b.text)}</code></pre></div>'


def who(role):
	return f'<span class="who">{ROLE_LABEL[role]}</span>'


def step_rows(sid, n, step):
	actions = []
	for a in step.do:
		actions.append(f'<li>{who(a.role)}{a.text}{"".join(block(b) for b in a.blocks)}</li>')
	should = []
	if step.see:
		should += [f'<p>{who(r)}{t}</p>' for r, t in step.see]
	elif not step.write:
		should.append('<p class="none">Nothing fixed: write down what you see.</p>')
	if step.write:
		should.append(f'<div class="write"><label for="{sid}-w"><b>Write down:</b> {step.write}</label>{ruled(f"{sid}-w", 3)}</div>')
	choices = ['As described', 'Different', 'Skipped'] if step.see else ['Done', 'Skipped']
	ticks = ''.join(f'<label><input type="checkbox" id="{sid}-{c.lower()}"> {c}</label>' for c in choices)
	should.append(f'<div class="ticks">{ticks}</div>')
	return (f'<tbody id="{sid}"><tr><td class="n">{n}</td>'
		f'<td class="do"><p class="title">{step.title}</p><ol class="do">{"".join(actions)}</ol></td>'
		f'<td class="should"><div class="see">{"".join(should)}</div></td></tr></tbody>')


def steps_table(prefix, start, steps):
	rows = [step_rows(f'{prefix}{start + i}', start + i, s) for i, s in enumerate(steps)]
	return ('<table class="steps"><colgroup><col class="n"><col class="do"><col class="should"></colgroup>'
		'<thead><tr><th>#</th><th>What to do</th><th>What should happen</th></tr></thead>'
		+ ''.join(rows) + '</table>')


def tick_field(label, name, options):
	ticks = ''.join(f'<label><input type="checkbox" id="r-{name}-{i}"> {o}</label>' for i, o in enumerate(options))
	return f'<div class="field"><span class="label">{label}</span><div class="ticks">{ticks}</div></div>'


def text_field(label, name):
	return f'<div class="field"><label for="r-{name}">{label}</label><input type="text" id="r-{name}"></div>'


def area_field(label, name, rows=4):
	return f'<div class="field"><label for="r-{name}">{label}</label>{ruled(f"r-{name}", rows)}</div>'


def results(roles, last_hint):
	return ('<section class="results"><h2 class="first">Results</h2>'
		'<p>Each person fills this in on their own, at the end, whatever step you reached.</p><div class="form">'
		+ text_field('Name', 'name')
		+ text_field('Date, start time and end time', 'when')
		+ (tick_field('I was the', 'role', roles) if len(roles) > 1 else '')
		+ tick_field('My Mac', 'mac', ['Apple Silicon', 'Intel'])
		+ text_field('LiveCollab version (LiveCollab menu → About LiveCollab)', 'version')
		+ text_field(f'Number of the last step finished ({last_hint})', 'last')
		+ tick_field('We stopped because', 'why', ['Time ran out', 'Something stopped us', 'Other'])
		+ area_field('If something stopped you: which step, and what happened', 'stopped', 3)
		+ area_field('Installing and signing in: any step that didn\'t go as written', 'install', 3)
		+ area_field('The worst thing that happened: which step, what you saw, and what you\'d been doing just before', 'worst', 5)
		+ area_field('Anything else: things you tried that the guide didn\'t cover, and anything you noticed', 'else', 7)
		+ '</div></section>')


def page(title, file_title, byline, intro, body, description):
	return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{file_title}</title>
<meta name="description" content="{description}">
<style>{CSS}</style>
</head>
<body>
<main>
<h1>{title}</h1>
<p class="byline">{byline}</p>
{intro}
{body}
<div class="noprint" style="margin-top:48px"><p><button type="button" id="export-answers">Export my answers</button> <button type="button" id="clear-answers">Clear my answers on this page</button></p>
<p style="color:var(--muted);font-size:14.5px">Export copies every ticked box and written answer as plain text, and shows it below, so you can paste it into a message.</p>
<textarea id="export-text" readonly style="display:none;width:100%;min-height:220px;background:var(--code-bg);color:var(--code-text);border:1px solid var(--code-edge);border-radius:6px;padding:10px;font:12px/1.5 ui-monospace,Menlo,monospace"></textarea></div>
</main>
<script>{JS}</script>
</body>
</html>
"""


HOW_TO = """<p>Go in order. The steps that matter most come first, and they get less important as you go. You won't finish, and you don't need to: when time runs out, write down the number of the last step you finished.</p>
<p>Each step has two columns. <b>What to do</b> says who does it and exactly what to click or type. <b>What should happen</b> says what each person should see. Tick a box for every step, and write what you saw in your own words, especially when it surprised you or did nothing. A step that does nothing is a result too.</p>
<p>Every command and every piece of text to type sits in its own grey block with a <b>Copy</b> button. Paste it exactly as it is. Ticks and answers typed on this page are kept in this browser until you clear them.</p>"""


def build_solo():
	n = 0
	parts = ['<h2 class="first">Before you start</h2><p>About fifteen minutes, once.</p>']
	setup = g.install_steps('you', 'you')
	parts.append(steps_table('s', 1, setup))
	n = len(setup)
	for name, steps in g.SOLO_PARTS:
		parts.append(f'<h2>{name}</h2>')
		parts.append(steps_table('s', n + 1, steps))
		n += len(steps)
	parts.append(results(['You'], 'for example 23'))
	intro = HOW_TO
	return page('LiveCollab tester guide: one person', 'Tester Guide: Solo', f'{DATE} · For one person on one Mac · {VERSION}', intro, '\n'.join(parts),
		'The LiveCollab test guide for one person testing alone: install, then go through the steps in order and record what you see.'), n


def build_two(short=None):
	"""The two-person guide; with `short`, the print version: setup, the first `short` steps, Before anyone leaves and Results."""
	parts = []
	if short:
		# Print version: sections follow on from each other instead of starting new pages.
		parts.append('<style>@media print { h2 { break-before: auto; page-break-before: auto; margin-top: 26px; } }</style>')
	else:
		parts.append('<p class="noprint">Printing? Use the <a href="guide-two-print.html">short print version</a> instead: setup and the first steps, double-sided.</p>')
	parts += ['<h2 class="first">Before you start</h2><p>Both of you do steps 1 to 5, each on your own Mac. Only the host does steps 6 and 7.</p>']
	setup = g.install_steps('both', 'host')
	parts.append(steps_table('t', 1, setup))
	n = len(setup)
	for name, steps in (g.TWO_PARTS[:1] if short else g.TWO_PARTS):
		if short:
			steps = steps[:short]
		parts.append(f'<h2>{name}</h2>')
		if name == g.TWO_PARTS[0][0]:
			parts.append('<p class="note"><b>Before anyone leaves</b> — whatever step you reached, do the last section on this page before either of you closes the room.</p>')
		parts.append(steps_table('t', n + 1, steps))
		n += len(steps)
	main_count = n
	if short:
		parts.append(f'<p class="note"><b>The rest of the guide is at livecollab.dev</b> (Testing with someone else): step {n + 1} onwards, and extra steps for a third person. Carry on there on screen, then do Before anyone leaves below.</p>')
	else:
		parts.append('<h2>Extra steps if a third person is with you</h2>'
			'<p>Only if a third Mac is there. Do these after the steps above, then carry on from wherever you stopped. The third person does <a href="#t1">Before you start</a> steps 1 to 5 first.</p>')
		parts.append(steps_table('t', n + 1, g.THIRD_STEPS))
		n += len(g.THIRD_STEPS)
	leaving = ''.join(f'<li>{who(a.role)}{a.text}{"".join(block(b) for b in a.blocks)}</li>' for a in g.LEAVING)
	parts.append('<h2 id="leaving">Before anyone leaves</h2><p>Your work from the session should end up on the host\'s Mac. Do this before anyone leaves the Test room, whatever step you reached.</p>'
		f'<table class="steps"><colgroup><col class="n"><col class="do"><col class="should"></colgroup><thead><tr><th>#</th><th>What to do</th><th>What should happen</th></tr></thead>'
		f'<tbody id="leave"><tr><td class="n">✓</td><td class="do"><ol class="do">{leaving}</ol></td>'
		f'<td class="should"><div class="see"><p>{who("host")}Every file the guest named is on your Mac, with the guest\'s last changes in it.</p>'
		'<div class="write"><label for="leave-w"><b>Write down:</b> anything that was missing.</label>' + ruled('leave-w', 3) + '</div>'
		'<div class="ticks"><label><input type="checkbox" id="leave-ok"> Everything was there</label><label><input type="checkbox" id="leave-missing"> Something was missing</label></div></div></td></tr></tbody></table>')
	parts.append(results(['Host', 'Guest', 'Third person'], 'for example 31'))
	intro = HOW_TO + '<p>There are two roles. The <b>host</b> creates the room and opens the test project from their own Mac, so the files live on the host\'s disk; the host needs Python. The <b>guest</b> joins with an invite code and sees the host\'s folder, and doesn\'t need the project on their own Mac. Where a step goes in both directions, each direction is its own numbered step with its own result: one can work while the other doesn\'t.</p>'
	if short:
		return page('LiveCollab tester guide: two people (print)', 'Tester Guide: Print', f'{DATE} · For two people on two Macs · short print version, the full guide is at livecollab.dev · {VERSION}', intro, '\n'.join(parts),
			'The short print version of the LiveCollab two-person test guide.'), (main_count, n)
	return page('LiveCollab tester guide: two people', 'Tester Guide: Two People', f'{DATE} · For two people on two Macs, a host and a guest · {VERSION}', intro, '\n'.join(parts),
		'The LiveCollab test guide for two people testing together: install, get into one room, go through the steps in order and record what each of you sees.'), (main_count, n)


def main():
	out = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/Desktop/livecollab-site')
	solo, solo_n = build_solo()
	two, two_n = build_two()
	short_steps = int(os.environ.get('LC_GUIDE_SHORT_STEPS', SHORT_STEPS))
	short, short_n = build_two(short_steps)
	with open(os.path.join(out, 'guide-two-print.html'), 'w') as f:
		f.write(short)
	with open(os.path.join(out, 'guide-solo.html'), 'w') as f:
		f.write(solo)
	with open(os.path.join(out, 'guide-two.html'), 'w') as f:
		f.write(two)
	print(f'guide-two-print.html: steps 1 to {short_n[0]}')
	print(f'guide-solo.html: {solo_n} steps; guide-two.html: {two_n[0]} steps plus {two_n[1] - two_n[0]} third-person extras')


if __name__ == '__main__':
	main()
