// SPDX-License-Identifier: GPL-3.0-only
/** Capri's panel under the macOS menu bar icon. Main sends localized state. */
const api = window.capriMenuBar;
const $ = (id) => document.getElementById(id);
const panel = $('panel');
const form = $('ask');
const input = $('ask-text');
const send = $('ask-send');
const svg = 'http://www.w3.org/2000/svg';
const ICONS = {
  microphone: [
    ['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }],
    ['path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }],
  ],
  voice: [['path', { d: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12' }]],
  focus: [['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' }]],
};
let sending = false;

function icon(id) {
  const root = document.createElementNS(svg, 'svg');
  root.setAttribute('viewBox', '0 0 24 24');
  root.setAttribute('aria-hidden', 'true');
  for (const [name, attributes] of ICONS[id] ?? []) {
    const shape = document.createElementNS(svg, name);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    root.append(shape);
  }
  return root;
}

function act(action, value) {
  return api.act(action, value).catch(() => false);
}

function tile({ id, label, on, enabled }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.id = id;
  button.setAttribute('aria-pressed', String(Boolean(on)));
  button.disabled = enabled === false;
  const text = document.createElement('span');
  text.textContent = label;
  button.append(icon(id), text);
  button.onclick = () => void act(id);
  return button;
}

function action(item) {
  if (item.separator) return document.createElement('hr');
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.id = item.id;
  if (item.tone) button.dataset.tone = item.tone;
  button.disabled = item.enabled === false;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = item.label;
  button.append(label);
  if (item.shortcut) {
    const shortcut = document.createElement('kbd');
    shortcut.textContent = item.shortcut;
    button.append(shortcut);
  }
  button.onclick = () => void act(item.id);
  return button;
}

function render(state) {
  if (!state) return;
  const focused = document.activeElement?.dataset?.id;
  document.documentElement.lang = state.language;
  document.documentElement.dir = state.direction;
  panel.dataset.mood = state.mood;
  $('panel-status').textContent = state.status;
  $('ask-label').textContent = state.labels.message;
  panel.setAttribute('aria-label', state.labels.panel);
  input.placeholder = state.labels.placeholder;
  send.setAttribute('aria-label', state.labels.send);
  send.title = state.labels.send;
  $('tiles').replaceChildren(...state.toggles.map(tile));
  $('actions').replaceChildren(...state.actions.map(action));
  if (focused) document.querySelector(`[data-id="${CSS.escape(focused)}"]`)?.focus();
  sync();
}

function sync() {
  send.disabled = sending || !input.value.trim();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || sending) return;
  sending = true;
  delete panel.dataset.busy;
  sync();
  try {
    if (await act('ask', text)) input.value = '';
    else panel.dataset.busy = 'true';
  } finally {
    sending = false;
    sync();
  }
});
input.addEventListener('input', () => {
  delete panel.dataset.busy;
  sync();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  void act('close');
});

let reported = 0;
new ResizeObserver(() => {
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height === reported) return;
  reported = height;
  void act('size', height);
}).observe(document.body);

api.onState(render);
api.onShown(() => {
  delete panel.dataset.busy;
  input.focus();
  input.select();
});
api
  .state()
  .then(render)
  .catch(() => {});
sync();
