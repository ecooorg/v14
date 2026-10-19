import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const status = readFileSync(new URL('../docs/STATUS.md', import.meta.url), 'utf8');
const journal = readFileSync(new URL('../docs/PATCH_JOURNAL.md', import.meta.url), 'utf8');
const modeMenu = readFileSync(new URL('../src/ModeMenu.tsx', import.meta.url), 'utf8');
const projectUi = readFileSync(new URL('../src/ProjectMode.tsx', import.meta.url), 'utf8');

test('UI1 start screen offers all three explicit modes', () => {
  for (const mode of ['Simple', 'Expert', 'Project']) assert.match(app, new RegExp(`<h2>${mode}</h2>`));
  assert.match(app, /onClick=\{\(\) => chooseStartMode\('Simple'\)\}/);
  assert.match(app, /onClick=\{\(\) => chooseStartMode\('Expert'\)\}/);
});

test('unavailable Project is disabled and not silently substituted', () => {
  assert.match(app, /disabled=\{!projectModeEnabled\}/);
  assert.match(app, /Currently unavailable/);
  assert.match(app, /if \(mode === 'Project' && !projectModeEnabled\) return/);
});

test('mode selection is explicit and session-persisted', () => {
  assert.match(app, /setExpertMode\(mode === 'Expert'\)/);
  assert.match(app, /sessionStorage\.setItem\((START_MODE_KEY|'biforge-start-mode'), mode\)/);
  assert.match(modeMenu, /START_MODE_KEY = 'biforge-start-mode'/);
});

test('STATUS orders QA1 between UI1 and MANUAL1 and records approved UX1 decision', () => {
  const ui = status.indexOf('**UI1**');
  const qa = status.indexOf('**QA1**');
  const manual = status.indexOf('**MANUAL1**');
  assert.ok(ui >= 0, 'STATUS must mention **UI1**');
  assert.ok(qa >= 0, 'STATUS must mention **QA1**');
  assert.ok(manual >= 0, 'STATUS must mention **MANUAL1**');
  assert.ok(ui < qa && qa < manual, 'STATUS order: UI1 before QA1 before MANUAL1');
  assert.doesNotMatch(status, /UX1 feedback\?/i);
});

test('patch journal records existing folder picker menu behavior', () => {
  assert.match(journal, /PICK_FOLDER_EVENT/);
});

test('Change mode control returns to start screen', () => {
  assert.match(modeMenu, /data-testid="change-mode"/);
  assert.match(app, /resetStartMode|onChangeMode/);
  assert.match(app, /sessionStorage\.removeItem\((START_MODE_KEY|'biforge-start-mode')\)/);
});

test('P51: one Mode control on every screen; the old duplicate items are gone from More', () => {
  // Shared control: current mode on the button, three modes + a way back to the start screen in the list
  assert.match(modeMenu, /data-testid="mode-menu-button"/);
  assert.match(modeMenu, /role="menuitemradio"/);
  for (const m of ['Simple', 'Expert', 'Project']) assert.match(modeMenu, new RegExp(`mode: '${m}'`));
  assert.match(modeMenu, /Back to mode selection/);
  // Chat shell (Simple and Expert share one Header) renders it first and wires the existing handlers
  assert.match(app, /<ModeMenu current=\{props\.expertMode \? 'Expert' : 'Simple'\}/);
  assert.match(app, /onSelectMode=\{chooseStartMode\}/);
  assert.match(app, /onChangeMode=\{resetStartMode\}/);
  // Project page uses the same component instead of its own back links
  assert.match(projectUi, /<ModeMenu current="Project"/);
  assert.equal((projectUi.match(/Back to mode selection/g) || []).length, 0, 'no duplicated back link on the Project page');
  // The three overlapping More-menu items are removed
  assert.doesNotMatch(app, /Mode selection \(Simple \/ Expert \/ Project\)/);
  assert.doesNotMatch(app, /Switch to Expert method|Switch to Simple chat/);
  assert.doesNotMatch(app, /data-testid="toggle-expert-menu"/);
  assert.doesNotMatch(app, /Project workspace \(separate\)/);
  // Returning from /project as Expert must open Expert, not Simple
  assert.match(app, /getItem\(START_MODE_KEY\) === 'Expert'/);
});
