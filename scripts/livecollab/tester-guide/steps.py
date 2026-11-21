# Step data for the two tester guides (guide-solo.html, guide-two.html).
# build.py renders both pages from this file, so the shared parts (install,
# setup, results form) can't drift apart.
#
# A step is S(title, do, see, write):
#   do    - list of A(role, text, *blocks): one action, who does it, and any
#           command or text to type, each in its own copyable block.
#   see   - list of (role, text): what each person should see. None if the
#           step only asks for an observation.
#   write - what to write down, or None.
# Blocks: T(cmd) runs in Terminal; K(text) is typed (or pasted) in LiveCollab.
# Every command runs as pasted. Commands that touch the project start with CD,
# so they work from any Terminal window.

from collections import namedtuple

Step = namedtuple('Step', 'title do see write')
Action = namedtuple('Action', 'role text blocks')
Block = namedtuple('Block', 'kind text')


def S(title, do, see=None, write=None):
	return Step(title, do, see, write)


def A(role, text, *blocks):
	return Action(role, text, list(blocks))


def T(cmd):
	return Block('term', cmd)


def K(text):
	return Block('type', text)


def N(name):
	return f'<code>{name}</code>'


CD = T('cd ~/Desktop/lc-sample-schedule-builder')
PROJECT = 'lc-sample-schedule-builder'

# ---------------------------------------------------------------- shared

APPLE_SILICON = 'https://github.com/EmmanuelOkwuma/livecollab-releases/releases/download/build-9927109/LiveCollab-AppleSilicon-9927109-release.zip'
INTEL = 'https://github.com/EmmanuelOkwuma/livecollab-releases/releases/download/build-9927109/LiveCollab-Intel-9927109-release.zip'


def install_steps(everyone, host):
	"""Install and sign-in steps. `everyone` does the app steps; `host` the project steps."""
	return [
		S('Find out which Mac you have', [
			A(everyone, 'Open the <b>Terminal</b> app (press Cmd+Space, type Terminal, press Return). Paste this and press Return:', T('uname -m')),
		], [(everyone, f'{N("arm64")} means Apple Silicon. {N("x86_64")} means Intel.')]),
		S('Download LiveCollab', [
			A(everyone, f'Download the one that matches: <a href="{APPLE_SILICON}">Apple Silicon</a> or <a href="{INTEL}">Intel</a>. Both are also on <a href="index.html">livecollab.dev</a>.'),
			A(everyone, 'Open the Downloads folder in Finder and double-click the zip if it isn\'t unzipped already.'),
			A(everyone, 'Drag <b>LiveCollab</b> into <b>Applications</b>. Do this before opening it: opened straight from Downloads, macOS runs it from a temporary place where it misbehaves.'),
		], [(everyone, 'LiveCollab in your Applications folder.')]),
		S('Open it the first time', [
			A(everyone, 'Open <b>LiveCollab</b> from Applications. macOS checks it first, which can take a minute. Then it stops you, because LiveCollab isn\'t signed by Apple yet.'),
			A(everyone, 'Click <b>Done</b>. Not Move to Trash.'),
			A(everyone, 'Apple menu → <b>System Settings</b> → <b>Privacy &amp; Security</b>. Scroll to the bottom. Next to the line saying LiveCollab was blocked, click <b>Open Anyway</b>, and confirm with your password or Touch ID.'),
			A(everyone, 'If another dialog asks whether to open LiveCollab, click <b>Open Anyway</b> there too.'),
		], [(everyone, 'First, a message: “LiveCollab” Not Opened. Apple could not verify “LiveCollab” is free of malware…” On an older macOS there may be an <b>Open</b> button instead; click it and skip the System Settings part. At the end: the LiveCollab sign-in screen.')]),
		S('Let it use your keychain', [
			A(everyone, 'When macOS asks whether LiveCollab may use “LiveCollab Safe Storage”, type your Mac password and click <b>Always Allow</b>.'),
		], [(everyone, 'The dialog closes. The app may already be open behind it; that\'s normal.')]),
		S('Sign up', [
			A(everyone, 'Click <b>Sign Up</b>. Continue with Google, or make an account with an email and a password.'),
			A(everyone, 'Pick a display name. It\'s the name on your cursor, so others can tell you apart.'),
			A(everyone, 'The next two questions can be skipped.'),
		], [(everyone, 'The dashboard, greeting you by your display name.')]),
		S('Check Python is there', [
			A(host, 'In Terminal, paste this and press Return:', T('python3 --version')),
			A(host, 'If macOS offers to install the command line developer tools instead, click <b>Install</b>, wait for it to finish, and run the command again.'),
		], [(host, f'A version, such as {N("Python 3.9.6")}.')]),
		S('Put the test project on your Desktop', [
			A(host, 'Download <a href="livecollab-test-project.zip">livecollab-test-project.zip</a>.'),
			A(host, 'In Terminal, paste these one at a time:', T('cd ~/Downloads'), T('unzip -o livecollab-test-project.zip -d ~/Desktop')),
			A(host, f'If it says it can\'t find the zip, Safari has already unzipped it. Paste this instead:', T(f'mv ~/Downloads/{PROJECT} ~/Desktop/')),
			A(host, 'Check it:', T(f'ls ~/Desktop/{PROJECT}')),
		], [(host, f'{N("README.md")} {N("data")} {N("run.sh")} {N("scheduler")} {N("tests")} {N("web")}')]),
	]


# ---------------------------------------------------------------- one person

SOLO_PARTS = [
('If these break, nothing else matters', [
	S('Sign in', [
		A('you', 'If you\'re not signed in, click <b>Sign In</b> and sign in with the account you made.'),
	], [('you', 'The dashboard, greeting you by your display name.')]),
	S('Create a room', [
		A('you', 'Click <b>New Room</b>. Type this as the name:', K('Test room')),
		A('you', 'Click <b>Create room</b>.'),
	], [('you', 'An “Opening room…” screen, then the editor. The window title includes “Test room”.')]),
	S('Open the project folder in the room', [
		A('you', f'<b>File → Open Folder…</b> Click <b>Desktop</b> in the sidebar, select {N(PROJECT)}, click <b>Open</b>.'),
	], [('you', f'The Explorer on the left lists {N("data")}, {N("scheduler")}, {N("tests")}, {N("web")}, {N(".editorconfig")}, {N("README.md")} and {N("run.sh")}.')]),
	S('New folder and new file', [
		A('you', 'In the Explorer, hover over the project\'s name and click the <b>New Folder</b> icon. Type this and press Return:', K('scratch')),
		A('you', f'Right-click {N("scratch")} → <b>New File…</b> Type this and press Return:', K('a.txt')),
		A('you', 'In the editor, type this, then press Cmd+S:', K('hello')),
	], [('you', f'{N("scratch")} with {N("a.txt")} inside it. The tab shows no dot after Cmd+S.')]),
	S('Rename', [
		A('you', f'Right-click {N("a.txt")} → <b>Rename…</b> Type this and press Return:', K('b.txt')),
	], [('you', f'{N("b.txt")} in the Explorer. The open tab shows the new name.')]),
	S('Delete, and check the disk', [
		A('you', f'Right-click {N("b.txt")} → <b>Delete</b> → <b>Move to Trash</b>.'),
		A('you', 'In Terminal, paste these one at a time:', CD, T('ls scratch')),
	], [('you', f'{N("scratch")} is empty in the Explorer, and {N("ls")} prints nothing.')]),
	S('Save All', [
		A('you', f'Open {N("README.md")} and type a word anywhere. Open {N("web/format.js")} and type a word anywhere. Don\'t save.'),
		A('you', '<b>File → Save All</b>.'),
	], [('you', 'Before: a dot on both tabs. After Save All: no dots.')]),
	S('Auto Save', [
		A('you', '<b>File → Auto Save</b> (it gets a tick).'),
		A('you', f'Type a word in {N("README.md")}. Wait three seconds without pressing anything.'),
		A('you', '<b>File → Auto Save</b> again to turn it off.'),
	], [('you', 'The dot on the tab appears, then goes away by itself.')]),
	S('Back to the dashboard and in again', [
		A('you', 'Click the <b>LiveCollab Dashboard</b> button at the bottom of the bar on the far left.'),
		A('you', 'On the dashboard, click the <b>Test room</b> card.'),
	], [('you', 'The same room with the same folder, and no error. The Members panel looks as it did.')]),
	S('Quit and come back', [
		A('you', 'Press Cmd+Q.'),
		A('you', 'Open LiveCollab from Applications. Click the <b>Test room</b> card.'),
	], [('you', 'Still signed in. The room opens with the folder, and nothing says the folder is different or missing.')]),
	S('A file made outside the editor', [
		A('you', 'In Terminal, paste these one at a time:', CD, T('echo hello > made-in-terminal.txt')),
		A('you', 'Watch the Explorer for 30 seconds.'),
	], None, f'Did {N("made-in-terminal.txt")} appear in the Explorer? After how long?'),
]),
('The everyday surface', [
	S('Invite code', [
		A('you', 'In the Explorer, open the <b>Members</b> section. Click <b>Create invite code</b>, then <b>Copy</b>.'),
		A('you', 'Open the Notes app and press Cmd+V.'),
	], [('you', 'A code appears with a Copy button. After Copy, the code disappears and the button says “Copied” for a moment. Notes shows the code.')]),
	S('Things the room never shares', [
		A('you', 'In Terminal, paste these one at a time:', CD,
			T('touch .env id_rsa api_token.txt credentials.json'),
			T("printf '\\x89PNG\\r\\n\\x1a\\n' > logo.png"),
			T('ln -s ~/Documents docs-link')),
		A('you', 'In LiveCollab: the <b>LiveCollab Dashboard</b> button, then the <b>Test room</b> card.'),
	], [('you', 'A notice listing the items that weren\'t shared, each marked secret or link.')], 'The notice, word for word.'),
	S('Rename a shared file to a secret name', [
		A('you', f'Right-click {N("scratch")} → <b>New File…</b> Type this and press Return:', K('notes.txt')),
		A('you', f'Right-click {N("notes.txt")} → <b>Rename…</b> Type this and press Return:', K('.env')),
	], [('you', 'A notice that it\'s no longer shared with the room. The file stays on your Mac.')]),
	S('An empty file', [
		A('you', 'New File at the top of the project. Type this and press Return:', K('empty.txt')),
		A('you', 'Leave it empty. Close the tab and open the file again.'),
	], None, 'Anything slow, frozen or wrong.'),
	S('A 10,000-character line', [
		A('you', 'In Terminal, paste this. It puts the line on your clipboard:', T("python3 -c \"print('x' * 10000, end='')\" | pbcopy")),
		A('you', 'New File at the top of the project:', K('long.txt')),
		A('you', 'Press Cmd+V, then Cmd+S. Scroll to the end of the line and back.'),
	], None, 'Anything slow, frozen or wrong.'),
	S('Emoji and accents', [
		A('you', 'New File at the top of the project:', K('emoji.md')),
		A('you', 'Paste this:', K('👩🏽‍💻 café')),
		A('you', 'Press Backspace once at a time until the line is empty.'),
	], None, 'Did each Backspace remove one character cleanly, or did anything break apart?'),
	S('A deep path', [
		A('you', 'New File at the top of the project. Type this whole path and press Return:', K('a/b/c/d/e/f/g/h/deep.txt')),
	], [('you', f'Folders {N("a")} through {N("h")}, one inside the other, with {N("deep.txt")} at the bottom.')]),
	S('Unusual names', [
		A('you', 'New File at the top of the project:', K('Makefile')),
		A('you', 'New File at the top of the project:', K('my notes ü.md')),
	], [('you', 'Both files, with exactly those names.')]),
	S('Twenty files in twenty seconds', [
		A('you', f'As fast as you can, make New Files {N("f1.txt")}, {N("f2.txt")}, and so on to {N("f20.txt")}.'),
	], None, 'Did all twenty appear? Anything slow or out of order?'),
	S('The room cards', [
		A('you', 'Go to the dashboard. Pin a room (the pin on its card). Search for it in the search box. Drag a card to a new place.'),
		A('you', 'Press Cmd+Q, then open LiveCollab again.'),
	], None, 'Which were still there after reopening: the pin, the new order?'),
	S('The status bar and the Members panel', [
		A('you', 'Open the <b>Test room</b>. Read the bar along the bottom of the window, and the Members section in the Explorer.'),
	], None, 'What each one shows.'),
	S('The editor\'s menus on a shared file', [
		A('you', f'Open {N("scheduler/models.py")}. Go through the <b>Edit</b>, <b>Selection</b> and <b>Go</b> menus, trying each item.'),
	], None, 'Items that did nothing or did something strange.'),
	S('Run the project', [
		A('you', '<b>Terminal → New Terminal</b>. In the terminal panel that opens, paste these one at a time:', CD, T('./run.sh build --grid')),
	], [('you', 'A timetable printed as a grid.')]),
	S('Debug', [
		A('you', f'Open {N("scheduler/__main__.py")}. Click just left of a line number in the middle of the file, so a red dot appears.'),
		A('you', '<b>Run → Start Debugging</b>. If asked, choose <b>Python Debugger</b>, then <b>Python File</b>.'),
	], None, 'Did it stop at the red dot? If not, what happened instead?'),
	S('Run a task', [
		A('you', '<b>Terminal → Run Task…</b>'),
	], None, 'What the list offered, and what happened when you picked one.'),
	S('Search', [
		A('you', f'In {N("scheduler/models.py")}, press Cmd+F and type:', K('class')),
		A('you', 'Press Cmd+Shift+F and type (with the space):', K('def ')),
		A('you', 'Press Cmd+P and type:', K('solver')),
		A('you', '<b>Go → Go to Symbol in Workspace…</b> and type:', K('Solver')),
	], None, 'Did each find what it should?'),
	S('Source Control', [
		A('you', 'In Terminal, paste these one at a time:', CD, T('git init -q && git add -A && git commit -q -m first')),
		A('you', f'Type a word in {N("README.md")} and save.'),
		A('you', 'Open the <b>Source Control</b> view on the left. Click <b>+</b> next to README.md. Type this as the message, then click <b>Commit</b>:', K('second')),
	], None, 'Anything odd.'),
	S('Split, palette, settings, shortcuts', [
		A('you', '<b>View → Editor Layout → Split Right</b>, then <b>Split Down</b>.'),
		A('you', 'Press Cmd+Shift+P and type:', K('LiveCollab')),
		A('you', 'Press Cmd+, to open Settings. Then <b>Code → Settings → Keyboard Shortcuts</b> (or the LiveCollab menu equivalent).'),
	], None, 'What the palette found for “LiveCollab”, and anything that didn\'t open.'),
]),
('The long tail', [
	S('Dashboard settings', [
		A('you', 'On the dashboard, open <b>Settings</b>. Go through every page: Profile, Cursor color, Sign-in method, Billing, Usage, Notifications, Privacy, Voice, Permissions, and the rest.'),
		A('you', 'On each page, change something and press the button at the bottom. Close Settings and open it again.'),
	], None, 'What was kept, what wasn\'t, and anything you didn\'t believe.'),
	S('The dashboard\'s numbers', [
		A('you', 'Read the line under the greeting on the dashboard (rooms active, collaborators online).'),
	], None, 'Do the numbers match reality?'),
	S('Sign-in screen extras', [
		A('you', 'Sign out. On the sign-in screen, try <b>Forgot password?</b>, the GitHub and Apple buttons, and the Terms and Privacy links. Sign back in.'),
	], None, 'What each one did.'),
	S('A big file', [
		A('you', 'In Terminal, paste these one at a time:', CD, T('yes hello | head -c 2000000 > big.txt')),
		A('you', f'In LiveCollab: the Dashboard button, the <b>Test room</b> card, then open {N("big.txt")}.'),
	], None, 'What you saw.'),
	S('Windows line endings', [
		A('you', 'In Terminal, paste these one at a time:', CD, T("printf 'one\\r\\ntwo\\r\\n' > crlf.txt")),
		A('you', f'In LiveCollab: the Dashboard button, the <b>Test room</b> card. Open {N("crlf.txt")}, add a word, save.'),
		A('you', 'In Terminal:', T('file crlf.txt')),
	], None, f'What {N("file")} printed.'),
	S('Window and workspace commands in a room', [
		A('you', 'Try each of these, opening the room again after each: <b>File → New Window</b>, <b>Add Folder to Workspace…</b>, <b>Open Workspace from File…</b>, <b>Close Folder</b>, <b>Close Workspace</b>.'),
		A('you', '<b>View → Editor Layout → Move Editor into New Window</b>.'),
	], None, 'What each one did.'),
	S('Appearance, themes, profiles, extensions', [
		A('you', 'Try the items under <b>View → Appearance</b>, the Themes and Profiles settings, the Extensions view (search python), and <b>Run → Install Additional Debuggers…</b>'),
	], None, 'Anything that didn\'t work.'),
	S('The Help menu', [
		A('you', 'Click each item in the <b>Help</b> menu.'),
	], None, 'What each one did.'),
	S('Local History', [
		A('you', f'Right-click {N("README.md")} → <b>Open Timeline</b> (or open the Timeline section at the bottom of the Explorer).'),
	], None, 'What it shows.'),
	S('Another account', [
		A('you', 'Sign out on the dashboard. Sign in with a second account.'),
	], [('you', 'None of the first account\'s rooms, codes or files.')]),
]),
]

# ---------------------------------------------------------------- two people

TWO_PARTS = [
('If these break, nothing else matters', [
	S('Into one room', [
		A('host', 'Click <b>New Room</b>, type this as the name, click <b>Create room</b>:', K('Test room')),
		A('host', f'<b>File → Open Folder…</b> Click <b>Desktop</b>, select {N(PROJECT)}, click <b>Open</b>.'),
		A('host', 'In the Explorer, open <b>Members</b>. Click <b>Create invite code</b>, then <b>Copy</b>. Send the code to the guest in a message.'),
		A('guest', 'On the dashboard, click <b>Join with Invite</b>, paste the code, click <b>Join room</b>.'),
	], [('host', 'The guest\'s name in Members. The bottom bar shows ● 2.'),
		('guest', 'The host\'s folder in the Explorer. The bottom bar shows ● 2.')]),
	S('Fingerprint two files before the guest edits them', [
		A('host', 'In Terminal, paste these one at a time:', CD, T('shasum scheduler/catalog.py web/format.js > ../sums.txt')),
		A('host', f'<b>Don\'t open {N("catalog.py")} or {N("format.js")} in the editor until step 5.</b>'),
	], [('host', 'Nothing printed. That\'s right: the fingerprints went into a file.')]),
	S('The guest edits and creates files', [
		A('guest', f'Open {N("scheduler/catalog.py")}. Add this as a new last line, then press Cmd+S:', K('# guest was here')),
		A('guest', f'Open {N("web/format.js")}. Add this as a new last line, then press Cmd+S:', K('// guest was here')),
		A('guest', 'New File at the top of the project:', K('from-guest.md')),
		A('guest', 'Type any three lines in it. Press Cmd+S.'),
	], [('guest', 'No dots on any tab.')]),
	S('The host checks the disk from Terminal', [
		A('host', 'In Terminal, paste these one at a time:', CD, T('shasum -c ../sums.txt'), T('cat from-guest.md')),
	], None, f'Host: what {N("shasum -c")} printed for each file (OK or FAILED), and what {N("cat")} printed. Guest: did anything tell you where your work was?'),
	S('The host opens one of the files', [
		A('host', f'Open {N("scheduler/catalog.py")} in the editor and look at its last line.'),
		A('host', 'In Terminal, paste these one at a time:', CD, T('shasum -c ../sums.txt')),
	], None, f'Host: is the guest\'s line in the editor? What {N("shasum -c")} printed this time.'),
	S('The host saves it', [
		A('host', f'Press Cmd+S in {N("catalog.py")}.'),
		A('host', 'In Terminal, paste these one at a time:', CD, T('shasum -c ../sums.txt')),
	], None, f'Host: what {N("shasum -c")} printed the third time.'),
	S('…and after the host steps out', [
		A('host', 'Click the <b>LiveCollab Dashboard</b> button (bottom of the far-left bar), then the <b>Test room</b> card.'),
		A('host', f'Open {N("web/format.js")} in the editor and look at its last line.'),
		A('host', 'In Terminal, paste these one at a time:', CD, T('shasum -c ../sums.txt')),
	], None, f'Host: is the guest\'s line in {N("format.js")}? What {N("shasum -c")} printed.'),
	S('Typing, host to guest', [
		A('both', f'Open {N("scheduler/models.py")}.'),
		A('host', 'Type a comment for half a minute, anywhere in the file.'),
	], [('host', 'A cursor with the guest\'s name where the guest is.'),
		('guest', 'The host\'s typing as it happens, under a cursor with the host\'s name.')]),
	S('Typing, guest to host', [
		A('guest', f'In {N("scheduler/models.py")}, type a comment for half a minute.'),
	], [('host', 'The guest\'s typing as it happens, under a cursor with the guest\'s name.'),
		('guest', 'A cursor with the host\'s name where the host is.')]),
	S('New file, host to guest', [
		A('host', 'New File at the top of the project. Type the whole path and press Return:', K('notes/host/plan.md')),
		A('host', 'Type this in it:', K('host line')),
	], [('guest', f'{N("notes/host/plan.md")} appears inside its folders within a few seconds. Opened, it shows “host line”.')]),
	S('New file, guest to host', [
		A('guest', 'New File at the top of the project:', K('notes/guest/ideas.md')),
		A('guest', 'Type this in it, then press Cmd+S:', K('guest line')),
		A('host', 'In Terminal, paste these one at a time:', CD, T('cat notes/guest/ideas.md')),
	], [('host', 'The file appears in the Explorer, and Terminal prints “guest line”.')]),
	S('Rename, host to guest', [
		A('host', f'Right-click {N("notes/host/plan.md")} → <b>Rename…</b>:', K('roadmap.md')),
	], [('guest', 'The new name in the Explorer. If the file was open, its tab follows the new name or closes.')]),
	S('Rename, guest to host', [
		A('guest', f'Right-click {N("notes/guest/ideas.md")} → <b>Rename…</b>:', K('brainstorm.md')),
		A('host', 'In Terminal, paste these one at a time:', CD, T('ls notes/guest')),
	], [('host', f'{N("brainstorm.md")} in the Explorer, and Terminal prints {N("brainstorm.md")}.')]),
	S('Delete, host to guest', [
		A('host', f'Right-click {N("notes/host/roadmap.md")} → <b>Delete</b> → <b>Move to Trash</b>.'),
	], [('guest', 'The file disappears. If it was open: “A file open in your editor was deleted in this room.”')]),
	S('Delete, guest to host', [
		A('guest', f'Right-click {N("notes/guest/brainstorm.md")} → <b>Delete</b>.'),
		A('host', 'In Terminal, paste these one at a time:', CD, T('ls notes/guest')),
	], [('host', 'Gone from the Explorer, and Terminal prints nothing.')]),
	S('A file the host makes in Terminal', [
		A('host', 'In Terminal, paste these one at a time:', CD, T('echo hello > made-in-terminal.txt')),
		A('both', 'Watch the Explorer for 30 seconds.'),
	], None, f'Each of you: did {N("made-in-terminal.txt")} appear? After how long?'),
	S('Same line, same moment', [
		A('both', f'In {N("scheduler/models.py")}, put your cursors at the end of the same line.'),
		A('both', 'One of you counts to three out loud. On “three”, both type a word.'),
	], [('host', 'Both words, nothing lost.'), ('guest', 'Exactly the same line as the host.')]),
	S('The guest joins while the host is typing', [
		A('guest', 'Click the <b>LiveCollab Dashboard</b> button.'),
		A('host', f'Start typing steadily in {N("README.md")} and keep going.'),
		A('guest', f'Click the <b>Test room</b> card and open {N("README.md")} while the host types.'),
	], [('host', 'The bottom bar goes ● 1, then ● 2.'),
		('guest', 'All of the host\'s text so far, then the typing live.')]),
	S('Unsaved guest work and the host closing the folder', [
		A('guest', f'Open {N("web/styles.css")}. Type this at the end. Don\'t save:', K('unsaved-close-test')),
		A('host', '<b>File → Close Folder</b>.'),
		A('host', f'<b>File → Open Folder…</b> → Desktop → {N(PROJECT)} → <b>Open</b>.'),
		A('host', 'In Terminal, paste these one at a time:', CD, T('grep unsaved-close-test web/styles.css')),
	], None, f'Each of you: what appeared on your screen. Guest: is your line still there? Host: is it in {N("styles.css")} in the editor? What did {N("grep")} print?'),
	S('Kick', [
		A('host', 'In Members, click <b>Kick</b> next to the guest.'),
		A('host', 'Create a new invite code, Copy, and send it. Guest: join again with it.'),
	], [('host', 'The bottom bar shows ● 1 and the guest leaves the list.'),
		('guest', '“You were removed from Test room.” and the dashboard.')]),
	S('Leave', [
		A('guest', 'In Members, click <b>Leave room…</b> then <b>Leave Room</b>.'),
		A('host', 'Create a new invite code, Copy, and send it. Guest: join again with it.'),
	], [('host', 'The bottom bar shows ● 1.'),
		('guest', 'The dashboard. The room\'s card is gone until you join again.')]),
	S('The guest steps out and back', [
		A('host', f'Keep typing in {N("README.md")}.'),
		A('guest', 'The <b>LiveCollab Dashboard</b> button, wait ten seconds, then the <b>Test room</b> card.'),
	], [('guest', f'Everything the host typed while you were out, in {N("README.md")}.')]),
	S('The host steps out and back', [
		A('guest', f'Keep typing in {N("README.md")}.'),
		A('host', 'The <b>LiveCollab Dashboard</b> button, wait ten seconds, then the <b>Test room</b> card.'),
	], None, 'Guest: while the host was out, could you keep editing? What did you see? Host: did all the guest\'s typing arrive?'),
	S('The host quits', [
		A('guest', f'Type steadily in {N("README.md")}.'),
		A('host', 'Press Cmd+Q. Wait a minute. Open LiveCollab and the <b>Test room</b> card.'),
	], None, 'Guest: what you saw while the host was gone. Host: did the guest\'s typing arrive?'),
	S('Both offline', [
		A('both', 'Turn Wi-Fi off (the Wi-Fi icon in the menu bar).'),
		A('host', f'Type three lines in {N("README.md")}.'),
		A('guest', f'Type three lines in {N("web/app.js")}.'),
		A('both', 'Turn Wi-Fi on. Wait 30 seconds.'),
	], None, 'Did all six lines arrive on both screens? Any notice? Write it down word for word.'),
	S('Lid, sleep and network change: host', [
		A('guest', f'Type steadily in {N("README.md")} throughout.'),
		A('host', 'Close the lid for two minutes, then open it.'),
		A('host', 'Apple menu → <b>Sleep</b>. Wake it after five minutes.'),
		A('host', 'Switch to a different Wi-Fi network, or to a phone hotspot.'),
	], None, 'Each of you: what you saw after the lid, after the sleep, after the network change.'),
	S('Lid, sleep and network change: guest', [
		A('host', f'Type steadily in {N("README.md")} throughout.'),
		A('guest', 'Close the lid for two minutes, then open it.'),
		A('guest', 'Apple menu → <b>Sleep</b>. Wake it after five minutes.'),
		A('guest', 'Switch to a different Wi-Fi network, or to a phone hotspot.'),
	], None, 'Each of you: what you saw after the lid, after the sleep, after the network change.'),
	S('A long break', [
		A('guest', 'Close the lid for 20 minutes or more.'),
		A('host', 'Meanwhile, edit several files.'),
		A('guest', 'Open the lid.'),
	], None, 'Guest: did everything catch up? Any notice?'),
	S('Deleting a room with unsaved guest work (a throwaway room only)', [
		A('host', 'In Terminal, paste these one at a time:', T('mkdir -p ~/Desktop/throwaway'), T('echo hello > ~/Desktop/throwaway/note.txt')),
		A('host', 'On the dashboard: <b>New Room</b>, name it as below, <b>Create room</b>. <b>File → Open Folder…</b> → Desktop → <b>throwaway</b>. Create an invite code and send it.', K('Throwaway')),
		A('guest', f'Join the Throwaway room. Open {N("note.txt")} and type this at the end. Don\'t save:', K('unsaved-delete-test')),
		A('host', 'The Dashboard button. On the <b>Throwaway</b> card, click the trash icon, then <b>Delete Room</b>. <b>Never delete the Test room.</b>'),
		A('host', 'In Terminal:', T('grep unsaved-delete-test ~/Desktop/throwaway/note.txt')),
		A('both', 'Go back into the Test room.'),
	], [('host', 'The Throwaway card is gone.'), ('guest', '“Throwaway was deleted.” and the dashboard.')],
		f'Host: what {N("grep")} printed. Guest: is your text kept anywhere?'),
]),
('The everyday surface', [
	S('The host deletes while the guest types', [
		A('guest', f'Type steadily inside one word in {N("README.md")}.'),
		A('host', 'Select that word and delete it.'),
	], [('host', 'The same text as the guest at the end.'), ('guest', 'The same text as the host at the end.')]),
	S('The guest deletes while the host types', [
		A('host', f'Type steadily inside one word in {N("README.md")}.'),
		A('guest', 'Select that word and delete it.'),
	], [('host', 'The same text as the guest at the end.'), ('guest', 'The same text as the host at the end.')]),
	S('The host pastes over the guest\'s typing', [
		A('host', 'In Terminal, paste this. It puts 200 lines on your clipboard:', T('seq 1 200 | pbcopy')),
		A('guest', f'Type steadily near the top of {N("web/app.js")}.'),
		A('host', 'Select the top 20 lines of the same file and press Cmd+V.'),
	], [('host', 'The same file as the guest.'), ('guest', 'The same file as the host.')]),
	S('The guest pastes over the host\'s typing', [
		A('guest', 'Select 200 lines anywhere (any file) and press Cmd+C.'),
		A('host', f'Type steadily near the top of {N("web/app.js")}.'),
		A('guest', 'Select the top 20 lines of the same file and press Cmd+V.'),
	], [('host', 'The same file as the guest.'), ('guest', 'The same file as the host.')]),
	S('Undo after the other typed: host presses Cmd+Z', [
		A('host', f'Type a line in {N("README.md")}.'),
		A('guest', 'Type the next line.'),
		A('host', 'Press Cmd+Z once.'),
	], None, 'Whose line did Cmd+Z remove?'),
	S('Undo after the other typed: guest presses Cmd+Z', [
		A('guest', f'Type a line in {N("README.md")}.'),
		A('host', 'Type the next line.'),
		A('guest', 'Press Cmd+Z once.'),
	], None, 'Whose line did Cmd+Z remove?'),
	S('The host renames a file the guest is typing in', [
		A('guest', f'Type steadily in {N("web/calendar.js")}.'),
		A('host', f'Right-click {N("web/calendar.js")} → <b>Rename…</b>:', K('cal.js')),
	], None, 'Guest: what happened to your tab and your typing?'),
	S('The guest renames a file the host is typing in', [
		A('host', f'Type steadily in {N("web/cal.js")}.'),
		A('guest', f'Right-click {N("web/cal.js")} → <b>Rename…</b>:', K('calendar.js')),
	], None, 'Host: what happened to your tab and your typing?'),
	S('The host deletes a file the guest has open and unsaved', [
		A('guest', 'New File at the top of the project, type a line, don\'t save:', K('tmp.txt')),
		A('host', f'Right-click {N("tmp.txt")} → <b>Delete</b> → <b>Move to Trash</b>.'),
	], None, 'Guest: what happened to your unsaved text?'),
	S('The guest deletes a file the host has open and unsaved', [
		A('host', 'New File at the top of the project, type a line, don\'t save:', K('tmp2.txt')),
		A('guest', f'Right-click {N("tmp2.txt")} → <b>Delete</b>.'),
	], None, 'Host: what happened to your unsaved text?'),
	S('Both save at once', [
		A('both', f'Type a line in {N("README.md")}. Count to three; on “three”, both press Cmd+S.'),
		A('host', 'In Terminal, paste these one at a time:', CD, T('tail -3 README.md')),
	], [('host', 'No errors or conflict dialogs. Both lines printed by Terminal.'), ('guest', 'No errors or conflict dialogs.')]),
	S('The host formats while the guest types', [
		A('guest', f'Type steadily in {N("web/app.js")}.'),
		A('host', 'Right-click in the file → <b>Format Document</b>. (If there\'s no formatter, use Cmd+Option+F to Replace All of a word instead.)'),
	], [('host', 'The same file as the guest, with the guest\'s typing kept.'), ('guest', 'The same file as the host, with your typing kept.')]),
	S('The guest formats while the host types', [
		A('host', f'Type steadily in {N("web/app.js")}.'),
		A('guest', 'Right-click in the file → <b>Format Document</b> (or Replace All of a word).'),
	], [('host', 'The same file as the guest, with your typing kept.'), ('guest', 'The same file as the host, with the host\'s typing kept.')]),
	S('Odd shapes: the host makes them, the guest checks', [
		A('host', 'New File:', K('empty.txt')),
		A('host', 'New File, then paste a 10,000-character line made by this Terminal command:', K('long.txt'), T("python3 -c \"print('x' * 10000, end='')\" | pbcopy")),
		A('host', 'New File, then paste the text below and delete it one Backspace at a time:', K('emoji.md'), K('👩🏽‍💻 café')),
		A('host', 'New File with each of these names:', K('a/b/c/d/e/f/deep.txt'), K('Makefile'), K('my notes ü.md')),
	], [('guest', 'Every file, with the right name and the right contents.')], 'Guest: anything missing, late or different.'),
	S('Odd shapes: the guest makes them, the host checks', [
		A('guest', 'New File with each of these names, and type a line in each:', K('g-empty.txt'), K('g/h/i/j/deep.txt'), K('GNUmakefile'), K('guest notes ü.md')),
		A('guest', 'In one file, paste the text below and delete it one Backspace at a time:', K('👩🏽‍💻 café')),
		A('host', 'In Terminal, paste these one at a time:', CD, T('ls'), T('ls g/h/i/j')),
	], [('host', 'Every file in the Explorer and in Terminal.')], 'Host: anything missing, late or different.'),
	S('The guest renames a file to a secret name', [
		A('guest', f'Right-click {N("from-guest.md")} → <b>Rename…</b>:', K('.env')),
	], [('guest', 'A notice that it can\'t be renamed to that in this room. It keeps its old name.')]),
	S('The guest tries to open a folder', [
		A('guest', '<b>File → Open Folder…</b> and pick any folder.'),
	], [('guest', 'A notice that only the room owner can attach a folder.')]),
	S('The guest finds things', [
		A('guest', 'Press Cmd+Shift+F and type (with the space):', K('def ')),
		A('guest', 'Press Cmd+P and type:', K('solver')),
		A('guest', f'In {N("scheduler/__main__.py")}, right-click a function that comes from another file → <b>Go to Definition</b>.'),
	], None, 'What each found.'),
	S('The guest\'s terminal and running the code', [
		A('guest', '<b>Terminal → New Terminal</b>. In the terminal panel:', T('pwd'), T('ls')),
		A('guest', 'Then try:', T('./run.sh build --grid')),
		A('guest', '<b>Terminal → Run Active File</b>.'),
	], None, 'Guest: where the terminal opened, and what ran.'),
	S('The guest reverts and saves as', [
		A('guest', f'Type a word in {N("web/app.js")}. Then <b>File → Revert File</b>.'),
		A('guest', '<b>File → Save As…</b> → Desktop → <b>Save</b>.'),
	], None, 'Host: what you saw of the guest\'s word after the Revert. Guest: what Revert did, where Save As went, and what the tab became.'),
	S('The guest\'s Source Control, Extensions, Timeline and Cmd+S', [
		A('guest', 'Open the <b>Source Control</b> view. Open the <b>Extensions</b> view and search python. Open the <b>Timeline</b> on a file. Press Cmd+S in a file.'),
	], None, 'What each showed.'),
	S('The guest makes an invite code', [
		A('guest', 'In Members, click <b>Create invite code</b>.'),
	], None, 'What the button did.'),
	S('Copy and paste a file: host', [
		A('host', f'In the Explorer, right-click {N("README.md")} → <b>Copy</b>, then right-click the project → <b>Paste</b>.'),
		A('guest', 'Find the copy in the Explorer and open it.'),
	], None, 'Guest: did the copy arrive, and with what in it?'),
	S('Copy and paste a file: guest', [
		A('guest', f'In the Explorer, right-click {N("run.sh")} → <b>Copy</b>, then right-click the project → <b>Paste</b>.'),
		A('host', 'In Terminal, paste these one at a time:', CD, T('ls'), T('cat "run copy.sh"')),
	], None, 'Host: did the copy arrive on disk, and with what in it?'),
	S('Viewer', [
		A('host', 'In Members, click <b>Viewer</b> next to the guest.'),
		A('guest', f'Type a word in {N("README.md")}. Then try New File, Rename and Delete on any file.'),
	], [('guest', 'The file changes refused with “you can only read files in this room”.')], 'Host: did the guest\'s typed word appear on your screen? Guest: what happened when you typed?'),
	S('Hand over ownership, and back', [
		A('host', 'In Members, click <b>Owner</b> next to the guest.'),
		A('both', 'Read your Members panel. Try New File once.'),
		A('guest', 'Now the owner: in Members, click <b>Owner</b> next to the host to hand it back.'),
	], None, 'Each of you: what your Members panel showed, and what you could do, while the guest was owner.'),
	S('Invite codes again', [
		A('host', 'Create a code and Copy it. Create a second code and Copy it.'),
		A('guest', 'Leave the room (Members → Leave room…). Join with the first code. If it fails, try the second.'),
	], None, 'Which codes worked?'),
	S('The guest quits and relaunches', [
		A('guest', 'Press Cmd+Q. Open LiveCollab and the <b>Test room</b> card.'),
	], None, 'Guest: anything missing afterwards.'),
	S('The host quits and relaunches', [
		A('host', 'Press Cmd+Q. Open LiveCollab and the <b>Test room</b> card.'),
	], None, 'Host: anything missing afterwards.'),
	S('Real work', [
		A('both', f'Open {N("README.md")} and find the section “Things to do with two people”. Pick a task, split it between you, and do it.'),
		A('host', 'Run it.'),
	], None, 'Which task, whether you finished, and what got in the way.'),
]),
('The long tail', [
	S('Both create the same file at once', [
		A('both', 'Count to three. On “three”, both make a New File at the top of the project:', K('same.md')),
	], None, 'How many appeared, on each screen?'),
	S('Both rename the same file differently', [
		A('host', f'On “three”, rename {N("web/types.d.ts")} to:', K('host-types.d.ts')),
		A('guest', 'At the same moment, rename it to:', K('guest-types.d.ts')),
	], None, 'Which name won, on each screen?'),
	S('The host edits a file outside the app', [
		A('guest', f'Type steadily in {N("README.md")}.'),
		A('host', 'In Terminal, paste these one at a time:', CD, T('echo outside >> README.md')),
	], None, 'What each of you saw.'),
	S('A dropped connection during a save', [
		A('guest', f'Type steadily in {N("README.md")}.'),
		A('host', 'Turn Wi-Fi off. Type a line, press Cmd+S, wait 30 seconds, turn Wi-Fi on.'),
	], None, 'What arrived where.'),
	S('The guest switches rooms', [
		A('guest', 'Create your own room from the dashboard and go into it. Then go back to the Test room.'),
	], None, 'Guest: anything left over from the other room (tabs, terminals, files)?'),
	S('A big file on both sides', [
		A('host', 'In Terminal, paste these one at a time:', CD, T('yes hello | head -c 2000000 > big.txt')),
		A('host', 'The Dashboard button, then the Test room card.'),
		A('guest', f'Open {N("big.txt")}.'),
	], None, 'Guest: what you saw.'),
	S('Two windows', [
		A('host', '<b>File → New Window</b> inside the room.'),
	], None, 'What the second window showed.'),
]),
]

# Extra steps for a third person. Optional: only if a third Mac is there.
THIRD_STEPS = [
	S('One code, two people', [
		A('host', 'Create an invite code, Copy, and send it to the guest and the third person.'),
		A('third', 'Join with the <b>same</b> code. If it fails, the host makes a new one for you.'),
	], [('everyone', 'The bottom bar shows ● 3 on every screen once all three are in.')], 'Did the same code work for the third person?'),
	S('Two arrive at once', [
		A('guest', 'Click the <b>LiveCollab Dashboard</b> button.'),
		A('third', 'Click the <b>LiveCollab Dashboard</b> button.'),
		A('everyone', 'Count to three. On “three”, guest and third both click the <b>Test room</b> card.'),
	], [('everyone', '● 3. Each person sees the other two in Members.')]),
	S('Three on one line', [
		A('everyone', f'In {N("scheduler/models.py")}, put your cursors at the end of the same line. On “three”, everyone types a word.'),
	], [('everyone', 'All three words. The same line on every screen, with three named cursors.')]),
	S('Two guests\' work on the host\'s disk', [
		A('host', 'In Terminal, paste these one at a time. Don\'t open either file afterwards:', CD, T('shasum scheduler/catalog.py web/format.js > ../sums3.txt')),
		A('guest', f'Add a line to {N("scheduler/catalog.py")} and press Cmd+S.'),
		A('third', f'Add a line to {N("web/format.js")} and press Cmd+S.'),
		A('host', 'In the same Terminal window:', T('shasum -c ../sums3.txt')),
	], None, f'Host: what {N("shasum -c")} printed.'),
	S('Kick one, the other carries on', [
		A('guest', f'Type steadily in {N("README.md")}.'),
		A('host', 'In Members, click <b>Kick</b> next to the third person.'),
	], [('guest', 'Typing unaffected. The bottom bar shows ● 2.'), ('third', '“You were removed from Test room.”')]),
	S('A Viewer with a witness', [
		A('host', 'Create a new code for the third person, who joins again. Then, in Members, click <b>Viewer</b> next to the guest.'),
		A('guest', f'Type a word in {N("README.md")}.'),
	], None, 'Host and third: did the viewer\'s word appear on your screen?'),
	S('Hand over ownership with a witness', [
		A('host', 'In Members, click <b>Owner</b> next to the guest. Then the guest hands it back the same way.'),
	], None, 'Each person: what your Members panel showed, and which buttons you had.'),
	S('One leaves, two carry on', [
		A('guest', 'In Members, <b>Leave room…</b> → <b>Leave Room</b>.'),
		A('host', 'Keep typing.'),
		A('third', 'Keep typing.'),
	], [('host', '● 2.'), ('third', '● 2, and typing unaffected.')]),
]

LEAVING = [
	A('guest', 'List every file you changed or created. Tell the host.'),
	A('host', 'Open each of those files in the editor. Then <b>File → Save All</b>.'),
	A('host', 'Check from Terminal. If you used git, paste these one at a time:', CD, T('git status')),
	A('host', 'Otherwise, look at the end of a couple of the files, for example:', T('tail -5 ~/Desktop/lc-sample-schedule-builder/README.md')),
	A('host', '<b>Don\'t delete the Test room</b> until you\'ve confirmed the files are on your Mac.'),
]
