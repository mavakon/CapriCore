// SPDX-License-Identifier: GPL-3.0-only
// First-run setup window. All work happens in the launcher (main process);
// this page only collects choices and shows progress.
'use strict';
(() => {
  const api = window.capriSetup;
  const $ = (id) => document.getElementById(id);
  const WIZARD = ['welcome', 'model', 'language', 'review'];
  const STAGES = {
    configuration: 'Save your choices',
    models: 'Download models',
    verify: 'Check that everything works',
    finalize: 'Finish',
  };
  let state = {};
  let options = null;
  let page = null;
  let source = 'local';
  let profile = null;
  const lines = [];

  const gb = (bytes) => (bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1) + ' GB';
  const modelName = (model) => {
    const tag = model.model.split(':')[1] ?? '';
    return `${model.family} ${tag.toUpperCase()}`;
  };
  const selectedModel = () => options?.models.find((item) => item.id === profile) ?? null;

  function show(name) {
    if (page === name) return;
    page = name;
    for (const section of document.querySelectorAll('.page'))
      section.classList.toggle('active', section.dataset.page === name);
    $('subtitle').textContent = WIZARD.includes(name)
      ? `Setup · step ${WIZARD.indexOf(name) + 1} of ${WIZARD.length}`
      : 'Setup';
    document.querySelector(`.page[data-page="${name}"] .primary:not(:disabled)`)?.focus();
  }

  function busy(title, detail, progress) {
    $('busy-title').textContent = title;
    $('busy-detail').textContent = detail;
    const bar = $('busy-progress');
    if (progress?.files) {
      bar.max = progress.files;
      bar.value = progress.done;
      $('busy-count').textContent =
        `${progress.done.toLocaleString()} of ${progress.files.toLocaleString()} files`;
    } else {
      bar.removeAttribute('value');
      $('busy-count').textContent = '';
    }
    show('busy');
  }

  function fillSelect(select, items, value) {
    select.replaceChildren(
      ...items.map((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        return option;
      }),
    );
    select.value = items.some((item) => item.id === value) ? value : items[0]?.id;
  }

  function renderModels() {
    const list = $('model-list');
    list.hidden = source !== 'local';
    list.replaceChildren(
      ...options.models.map((model) => {
        const label = document.createElement('label');
        label.className = 'choice' + (model.available ? '' : ' disabled');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'profile';
        input.value = model.id;
        input.disabled = !model.available;
        input.checked = model.id === profile;
        input.addEventListener('change', () => {
          profile = model.id;
          update();
        });
        const text = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = modelName(model);
        if (model.recommended) title.append(tag('Recommended'));
        if (model.experimental) title.append(tag('Experimental', 'experimental'));
        const detail = document.createElement('span');
        detail.className = 'muted small';
        detail.textContent = model.available
          ? `${model.downloadBytes ? gb(model.downloadBytes) + ' download · ' : ''}for ${model.ramGiB} GB of memory or more`
          : model.reason;
        text.append(title, detail);
        label.append(input, text);
        return label;
      }),
    );
  }
  function tag(text, kind = '') {
    const element = document.createElement('span');
    element.className = 'tag ' + kind;
    element.textContent = text;
    return element;
  }

  function setOptions(value) {
    const first = !options;
    options = value;
    $('license-text').textContent = value.license || 'See LICENSE in the Capri source code.';
    const hardware = value.hardware;
    $('hardware').textContent = [
      hardware.chip,
      `${gb(hardware.ramBytes)} memory`,
      hardware.unifiedMemory && hardware.gpuMemoryBytes
        ? `Metal can use about ${gb(hardware.gpuMemoryBytes)}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const available = value.models.filter((item) => item.available);
    if (!available.some((item) => item.id === profile))
      profile = available.some((item) => item.id === value.recommended)
        ? value.recommended
        : (available[0]?.id ?? null);
    const local = document.querySelector('input[name="source"][value="local"]');
    local.disabled = !available.length;
    local.closest('.choice').classList.toggle('disabled', !available.length);
    if (!available.length && source === 'local') {
      source = 'api';
      document.querySelector('input[name="source"][value="api"]').checked = true;
    }
    if (first) {
      fillSelect($('interface-language'), value.interfaceLanguages, value.defaults.interface);
      fillSelect(
        $('conversation-language'),
        value.conversationLanguages,
        value.defaults.conversation,
      );
    }
    renderModels();
    update();
  }

  function downloadBytes() {
    const model = selectedModel();
    return options.embeddingBytes + (source === 'local' && model ? (model.downloadBytes ?? 0) : 0);
  }

  function update() {
    if (!options) return;
    $('welcome-next').disabled = !$('accept-license').checked;
    $('model-list').hidden = source !== 'local';
    const model = selectedModel();
    $('model-next').disabled = source === 'local' && !model;
    $('model-note').textContent = !options.supported
      ? options.reasons.join(' ')
      : source === 'local'
        ? 'Larger models answer better but need more memory and take longer to download.'
        : 'Capri still downloads its small memory model, which runs on this Mac.';
    const total = downloadBytes();
    const rows = [
      [
        'Language model',
        source === 'local'
          ? `${model ? modelName(model) : '—'} on this Mac`
          : source === 'huggingface'
            ? 'Chosen from Hugging Face in Capri'
            : 'An online provider, set up in Capri',
      ],
      [
        'Downloads',
        `${gb(total)} (${source === 'local' ? 'language model and memory model' : 'memory model'})`,
      ],
      ['Free space', gb(options.freeBytes)],
      ['Capri data', options.dataFolder],
      [
        'Languages',
        [$('interface-language'), $('conversation-language')]
          .map((select) => select.selectedOptions[0]?.textContent ?? '')
          .join(' · '),
      ],
    ];
    $('summary').replaceChildren(
      ...rows.flatMap(([name, value]) => {
        const term = document.createElement('dt');
        term.textContent = name;
        const detail = document.createElement('dd');
        detail.textContent = value;
        return [term, detail];
      }),
    );
    $('downloads-label').textContent =
      `Download ${source === 'local' ? 'the language model and the memory model' : 'the memory model'} from Hugging Face (about ${gb(total)}).`;
    const space = options.freeBytes >= total + 2 ** 30;
    const error = $('review-error');
    error.hidden = space;
    error.textContent = space
      ? ''
      : `This Mac needs about ${gb(total + 2 ** 30)} of free space. Free up space, then choose Back and Continue again.`;
    $('run-button').disabled = !space || !$('accept-downloads').checked;
  }

  function request() {
    return {
      schemaVersion: 1,
      acceptLicense: $('accept-license').checked,
      acceptDownloads: $('accept-downloads').checked,
      inferenceMode: source === 'api' ? 'api' : 'local',
      modelSource: source === 'huggingface' ? 'huggingface' : 'catalog',
      ...(source === 'local' ? { profile } : {}),
      interfaceLanguage: $('interface-language').value,
      conversationLanguage: $('conversation-language').value,
      components: [],
    };
  }

  function renderStages(stages) {
    $('stages').replaceChildren(
      ...stages.map((id) => {
        const item = document.createElement('li');
        item.dataset.stage = id;
        item.textContent =
          STAGES[id] ??
          options?.components.find((component) => 'component:' + component.id === id)?.label ??
          id;
        return item;
      }),
    );
  }

  function appendLog(message) {
    lines.push(message);
    if (lines.length > 300) lines.splice(0, lines.length - 300);
    $('log').textContent = lines.join('\n');
  }

  function applyEvent(event) {
    switch (event.type) {
      case 'stage-plan':
        lines.length = 0;
        $('log').textContent = '';
        $('transfer').textContent = '';
        $('running-progress').value = 0;
        renderStages(event.stages);
        break;
      case 'stage':
        for (const item of $('stages').children) {
          if (item.dataset.stage === event.step) item.className = 'active';
          else if (item.className === 'active') item.className = 'done';
        }
        if (event.step !== 'models') $('transfer').textContent = '';
        break;
      case 'stage-complete':
        for (const item of $('stages').children)
          if (item.dataset.stage === event.step) item.className = 'done';
        break;
      case 'progress':
        $('running-progress').value = event.fraction;
        break;
      case 'download':
        $('transfer').textContent = `${event.file} · ${gb(event.received)} of ${gb(event.total)}`;
        break;
      case 'log':
        appendLog(event.message);
        break;
    }
  }

  function applyState(next) {
    state = next;
    switch (next.phase) {
      case 'starting':
      case 'checking':
        busy('Getting Capri ready…', '');
        break;
      case 'stopping':
        busy('Closing Capri…', 'Capri stops its running services before it updates them.');
        break;
      case 'installing':
        busy(
          next.fresh ? 'Installing Capri…' : 'Updating Capri…',
          'Copying Capri into ~/Library/Application Support/Capri.',
          next.progress,
        );
        break;
      case 'updated':
        busy('Capri is up to date', 'Opening Capri…');
        break;
      case 'moving':
        busy('Copying Capri to Applications…', '');
        break;
      case 'move':
        $('move-path').textContent = next.appPath;
        $('move-button').disabled = !next.canMove;
        show('move');
        break;
      case 'wizard':
        if (next.options) setOptions(next.options);
        // After a cancelled or failed run, return to the last step to try again.
        if (!WIZARD.includes(page))
          show(['running', 'failed'].includes(page) ? 'review' : 'welcome');
        break;
      case 'running':
        $('cancel-button').disabled = false;
        show('running');
        break;
      case 'complete':
        $('complete-detail').textContent =
          source === 'api'
            ? 'Capri asks for your provider and API key when it opens.'
            : source === 'huggingface'
              ? 'Choose a Hugging Face model in Capri when it opens.'
              : 'Capri opens in its own window and in the menu bar. Its first reply takes a little longer while the model loads.';
        show('complete');
        break;
      case 'failed':
        $('failed-detail').textContent = next.error ?? 'Unknown error.';
        show('failed');
        break;
    }
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.next) {
      if (button.dataset.next === 'review') update();
      show(button.dataset.next);
      return;
    }
    try {
      switch (button.dataset.action) {
        case 'quit':
          await api.quit();
          break;
        case 'move':
          button.disabled = true;
          await api.move();
          button.disabled = false;
          break;
        case 'run':
          button.disabled = true;
          await api.run(request());
          break;
        case 'cancel':
          button.disabled = true;
          await api.cancel();
          break;
        case 'finish':
          button.disabled = true;
          await api.finish();
          break;
        case 'open-logs':
          await api.openLogs();
          break;
        case 'retry':
          await api.retry(state.retry);
          break;
      }
    } catch (error) {
      button.disabled = false;
      const message = String(error.message).replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        '',
      );
      applyState({ ...state, phase: 'failed', error: message });
    }
  });
  document.addEventListener('change', (event) => {
    if (event.target.name === 'source') {
      source = event.target.value;
      renderModels();
    }
    update();
  });

  api.onState(applyState);
  api.onEvent(applyEvent);
  api.state().then(applyState);
})();
