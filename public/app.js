(() => {
  'use strict';

  const KEYWORD_PRESETS = {
    primary: {
      label: 'AI综合',
      keywords: ['AI产品经理', 'AI解决方案顾问', '大模型解决方案', 'AI客户成功', 'AI实施顾问', '数字化解决方案顾问'],
    },
    product: {
      label: '产品/运营',
      keywords: ['产品经理', '产品运营', '客户成功经理', '实施顾问', '业务流程顾问', 'SaaS解决方案顾问'],
    },
  };
  const DEFAULT_KEYWORDS = KEYWORD_PRESETS.primary.keywords;
  const state = { jobs: [], lifecycle: 'active', grade: 'all', source: 'all', sort: 'priority-desc', query: '', keywordPreset: 'primary', polling: false, settings: null, profile: null };
  let loadSequence = 0;
  const byId = (id) => document.getElementById(id);
  const elements = {
    tbody: byId('job-tbody'), empty: byId('empty-state'), stats: byId('stats-row'),
    statusBar: byId('status-bar'), statusText: byId('status-text'),
    crawlButtons: [...document.querySelectorAll('[data-crawl-source]')],
    loginButtons: [...document.querySelectorAll('[data-login-source]')],
    rescore: byId('btn-rescore'), refresh: byId('btn-refresh'), setup: byId('btn-setup'),
    overlay: byId('detail-overlay'), panel: byId('detail-panel'), search: byId('search-input'), sort: byId('sort-select'),
    setupOverlay: byId('setup-overlay'), setupModal: byId('setup-modal'),
    emptyTitle: byId('empty-title'), emptyHint: byId('empty-hint'),
  };

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  async function api(path, options) {
    const response = await fetch(path, options);
    let payload;
    try { payload = await response.json(); } catch { payload = { ok: false, error: `HTTP ${response.status}` }; }
    if (!response.ok || !payload.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
    return payload.data;
  }

  function setBusy(busy) {
    elements.crawlButtons.forEach((button) => { button.disabled = busy; });
    elements.loginButtons.forEach((button) => { button.disabled = busy; });
    elements.rescore.disabled = busy;
    elements.setup.disabled = busy;
  }

  function showStatus(message, active = false) {
    elements.statusBar.classList.remove('hidden');
    elements.statusBar.querySelector('.status-dot').style.animationPlayState = active ? 'running' : 'paused';
    elements.statusText.textContent = message;
    setBusy(active);
  }

  function hideStatus() {
    elements.statusBar.classList.add('hidden');
    setBusy(false);
  }

  function buildQuery() {
    const params = new URLSearchParams();
    params.set('lifecycle', state.lifecycle);
    if (state.grade !== 'all') params.set('grade', state.grade);
    if (state.source !== 'all') params.set('source', state.source);
    if (state.sort) params.set('sort', state.sort);
    if (state.query) params.set('q', state.query);
    return params.toString();
  }

  async function loadJobs() {
    const sequence = ++loadSequence;
    try {
      const jobs = await api(`/api/jobs?${buildQuery()}`);
      if (sequence !== loadSequence) return;
      state.jobs = jobs;
      renderStats();
      renderJobs();
    } catch (error) {
      if (sequence !== loadSequence) return;
      showStatus(`加载失败：${error.message}`);
    }
  }

  function renderStats() {
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    state.jobs.forEach((job) => { counts[job.score.grade] = (counts[job.score.grade] || 0) + 1; });
    const cards = [
      [state.lifecycle === 'active' ? '当前岗位' : state.lifecycle === 'archived' ? '历史岗位' : '全部岗位', state.jobs.length, ''], ['A级优先', counts.A, 'grade-a'],
      ['B级可投', counts.B, 'grade-b'], ['C/D谨慎', counts.C + counts.D, ''],
    ];
    elements.stats.replaceChildren(...cards.map(([label, value, klass]) => {
      const card = make('div', `stat-card ${klass}`.trim());
      card.append(make('div', 'stat-label', label), make('div', 'stat-value', value));
      return card;
    }));
  }

  function gradeColor(grade) {
    return { A: '#22c55e', B: '#3b82f6', C: '#f59e0b', D: '#ef4444' }[grade] || '#6b7280';
  }

  const contactLabels = {
    unprocessed: '未处理',
    drafted: '已生成草稿',
    greeted: '已打招呼',
    applied: '已投递',
    interviewing: '面试中',
    rejected: '已拒绝',
    closed: '已结束',
    follow_up: '需跟进',
  };

  const sourceLabels = {
    boss: 'BOSS',
    liepin: '猎聘',
    zhaopin: '智联',
  };

  const companyTypeLabels = {
    unknown: '未知',
    foreign: '外企',
    listed: '上市/成熟',
    mature: '成熟公司',
    startup: '创业公司',
    outsourcing: '外包/派遣',
  };

  const workLifeLabels = {
    unknown: '未知',
    weekends: '双休/弹性',
    big_small_week: '大小周',
    single_day_off: '单休',
    overtime_risk: '加班风险',
  };

  function formatDateTime(value) {
    if (!value) return '未记录';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  function renderJobs() {
    elements.tbody.replaceChildren();
    elements.empty.classList.toggle('hidden', state.jobs.length > 0);
    if (!state.jobs.length) {
      if (state.lifecycle === 'active') {
        elements.emptyTitle.textContent = '当前没有符合新鲜度规则的岗位';
        elements.emptyHint.textContent = '请手动点击对应平台抓取；系统不会自动访问招聘网站。';
      } else {
        elements.emptyTitle.textContent = '这个筛选下暂无岗位';
        elements.emptyHint.textContent = '可切换岗位状态或调整评级、来源与搜索条件。';
      }
    }
    for (const job of state.jobs) {
      const row = document.createElement('tr');
      row.tabIndex = 0;
      row.addEventListener('click', () => showDetail(job));
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter') showDetail(job); });

      const gradeCell = document.createElement('td');
      gradeCell.append(make('span', `grade-badge grade-${job.score.grade}`, job.score.grade));
      const scoreCell = document.createElement('td');
      scoreCell.append(make('strong', '', job.score.total));
      const bar = make('div', 'score-bar');
      const fill = make('div', 'score-bar-fill');
      fill.style.width = `${job.score.total}%`;
      fill.style.backgroundColor = gradeColor(job.score.grade);
      bar.append(fill);
      scoreCell.append(bar);
      const companyScore = make('td', 'company-score-cell', job.score.company_quality_score ?? 70);
      const title = make('td', 'job-title-cell', job.title);
      title.title = job.title;
      if (job.lifecycle_status === 'archived') title.append(make('span', 'lifecycle-badge', '历史'));
      const company = make('td', 'company-cell', job.company);
      company.title = job.company;
      const contact = document.createElement('td');
      contact.append(make('span', `contact-badge contact-${job.contact?.status || 'unprocessed'}`, contactLabels[job.contact?.status || 'unprocessed']));
      const salary = make('td', 'salary-cell', job.salary || '面议');
      const location = make('td', '', job.location || '未注明');
      const source = document.createElement('td');
      source.append(make('span', `source-tag src-${job.source}`, sourceLabels[job.source] || job.source));
      const seen = make('td', 'seen-cell', formatDateTime(job.last_seen_at));
      seen.title = `首次发现：${formatDateTime(job.first_seen_at)}\n最近发现：${formatDateTime(job.last_seen_at)}`;
      const expand = make('td', 'expand-icon', '›');
      row.append(gradeCell, scoreCell, companyScore, title, company, contact, salary, location, source, seen, expand);
      elements.tbody.append(row);
    }
  }

  function section(title, content) {
    const block = make('section', 'detail-section');
    block.append(make('h3', '', title), content);
    return block;
  }

  function tagList(values, className) {
    const list = make('div', 'skill-tags');
    if (!values.length) list.append(make('span', 'muted', '无'));
    else values.forEach((value) => list.append(make('span', `skill-tag ${className}`, value)));
    return list;
  }

  function flagList(values, positive) {
    const list = document.createElement('div');
    if (!values.length) list.append(make('span', 'muted', '无'));
    values.forEach((value) => {
      const item = make('div', 'flag-item');
      item.append(make('span', positive ? 'flag-icon-green' : 'flag-icon-red', positive ? '●' : '▲'), make('span', '', value));
      list.append(item);
    });
    return list;
  }

  function greetingSection(job) {
    const box = make('div', 'greeting-card');
    const note = make('p', 'greeting-note', '使用本地简历与当前 JD 调用已配置的模型 API；公开版只生成草稿，不会自动发送。');
    const actions = make('div', 'greeting-actions');
    const generate = make('button', 'btn btn-primary', '生成打招呼草稿');
    generate.type = 'button';
    const output = make('div', 'greeting-output hidden');
    const copy = make('button', 'btn btn-secondary hidden', '复制文案');
    copy.type = 'button';

    generate.addEventListener('click', async () => {
      generate.disabled = true;
      generate.textContent = '生成中…';
      output.className = 'greeting-output';
      output.textContent = '正在结合你的经历与岗位职责组织文案…';
      copy.classList.add('hidden');
      try {
        const result = await api(`/api/jobs/${encodeURIComponent(job.id)}/greeting`, { method: 'POST' });
        output.textContent = result.text;
        output.dataset.copyText = result.text;
        if (result.contact) job.contact = result.contact;
        copy.classList.remove('hidden');
      } catch (error) {
        output.className = 'greeting-output greeting-error';
        output.textContent = error.message;
      } finally {
        generate.disabled = false;
        generate.textContent = '重新生成草稿';
      }
    });

    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(output.dataset.copyText || '');
        copy.textContent = '已复制';
        setTimeout(() => { copy.textContent = '复制文案'; }, 1200);
      } catch {
        copy.textContent = '复制失败，请手动选择';
      }
    });
    actions.append(generate, copy);
    box.append(note, actions, output);
    return section('智能打招呼', box);
  }

  function companyProfileSection(job) {
    const profile = job.company_profile;
    const box = make('div', 'company-profile-card');
    if (!profile) {
      box.append(make('p', 'muted', '暂无公司画像，评分按中性公司分计算。'));
      return section('公司画像', box);
    }
    const grid = make('div', 'company-profile-grid');
    [
      ['公司分', profile.quality_score],
      ['类型', companyTypeLabels[profile.company_type] || profile.company_type],
      ['作息', workLifeLabels[profile.work_life] || profile.work_life],
      ['置信度', `${Math.round((profile.confidence || 0) * 100)}%`],
      ['更新时间', formatDateTime(profile.researched_at)],
      ['过期时间', formatDateTime(profile.expires_at)],
    ].forEach(([label, value]) => {
      const item = make('div', 'company-profile-item');
      item.append(make('span', 'company-profile-label', label), make('strong', '', value));
      grid.append(item);
    });
    box.append(grid, make('p', 'company-summary', profile.reputation_summary));
    if (profile.green_flags?.length) box.append(make('h4', '', '正向信号'), flagList(profile.green_flags, true));
    if (profile.red_flags?.length) box.append(make('h4', '', '风险信号'), flagList(profile.red_flags, false));
    const sources = make('div', 'company-sources');
    (profile.sources || []).slice(0, 8).forEach((source) => {
      const link = make('a', '', source.title || source.url);
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      sources.append(link);
    });
    if (profile.sources?.length) box.append(make('h4', '', '来源'), sources);
    return section('公司画像', box);
  }

  function contactSection(job) {
    const box = make('div', 'contact-card');
    const status = job.contact?.status || 'unprocessed';
    box.append(make('p', '', `当前状态：${contactLabels[status] || status}`));
    const actions = make('div', 'contact-actions');
    [
      ['applied', '标为已投递'],
      ['interviewing', '标为面试中'],
      ['follow_up', '标为需跟进'],
      ['rejected', '标为已拒绝'],
      ['closed', '标为已结束'],
    ].forEach(([nextStatus, label]) => {
      const button = make('button', 'btn btn-secondary', label);
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          job.contact = await api(`/api/jobs/${encodeURIComponent(job.id)}/contact`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: nextStatus }),
          });
          showDetail(job);
          loadJobs();
        } catch (error) {
          button.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
      actions.append(button);
    });
    box.append(actions);
    return section('沟通状态', box);
  }

  function showDetail(job) {
    const panel = elements.panel;
    panel.replaceChildren();
    const close = make('button', 'detail-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭详情');
    close.addEventListener('click', closeDetail);
    const header = make('div', 'detail-header');
    header.append(make('h2', '', job.title));
    const meta = make('div', 'detail-meta');
    meta.append(
      make('span', '', job.company),
      make('span', 'salary', job.salary || '面议'),
      make('span', '', job.location || '地点未注明'),
      make('span', `source-tag src-${job.source}`, sourceLabels[job.source] || job.source),
    );
    meta.append(
      make('span', 'seen-meta', `首次发现 ${formatDateTime(job.first_seen_at)}`),
      make('span', 'seen-meta', `最近发现 ${formatDateTime(job.last_seen_at)}`),
    );
    if (job.lifecycle_status === 'archived') meta.append(make('span', 'lifecycle-badge', '历史岗位'));
    if (job.is_headhunter) {
      meta.append(make('span', 'headhunter-badge', `猎头发布${job.recruiter_title ? ` · ${job.recruiter_title}` : ''}`));
    } else if (job.recruiter_name || job.recruiter_title) {
      meta.append(make('span', '', [job.recruiter_name, job.recruiter_title].filter(Boolean).join(' · ')));
    }
    header.append(meta, make('p', 'muted', job.score.summary));
    panel.append(close, header);

    const breakdown = make('div', 'score-breakdown');
    const dimensions = [
      ['方向', job.score.dimensions.role_fit, 30], ['能力', job.score.dimensions.capability_fit, 25],
      ['门槛', job.score.dimensions.threshold_fit, 15], ['条件', job.score.dimensions.condition_fit, 15],
      ['机会', job.score.dimensions.opportunity_quality, 15], ['公司', job.score.dimensions.company_quality ?? job.score.company_quality_score ?? 70, 100],
      ['风险', job.score.dimensions.risk_penalty, 0],
    ];
    dimensions.forEach(([label, value, max]) => {
      const item = make('div', 'score-item');
      item.append(make('div', 'score-label', label), make('span', 'score-num', value), make('span', 'score-max', max ? `/${max}` : ''));
      breakdown.append(item);
    });
    panel.append(section(`综合评分 ${job.score.total} · 岗位 ${job.score.job_match_score ?? job.score.total} · 公司 ${job.score.company_quality_score ?? 70}`, breakdown));
    panel.append(companyProfileSection(job));
    panel.append(contactSection(job));
    panel.append(section('匹配能力', tagList(job.score.matched_skills, 'matched')));
    if (job.score.required_gaps.length) panel.append(section('明确能力差距', tagList(job.score.required_gaps, 'missing')));
    if (job.score.insufficient_evidence.length) panel.append(section('信息不足', tagList(job.score.insufficient_evidence, '')));
    panel.append(section('绿灯信号', flagList(job.score.green_flags, true)));
    panel.append(section('红灯信号', flagList(job.score.red_flags, false)));

    const evidence = make('div', 'jd-text');
    job.score.evidence.forEach((item) => evidence.append(make('p', '', `【${item.category}】${item.text}`)));
    panel.append(section('评分依据', evidence));
    panel.append(greetingSection(job));
    panel.append(section('岗位描述', make('div', 'jd-text', job.jd_fulltext || '未抓取到岗位详情')));
    if (/^https?:\/\//i.test(job.url)) {
      const link = make('a', 'detail-link', '打开原始岗位 ↗');
      link.href = job.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      panel.append(link);
    } else {
      panel.append(make('span', 'muted detail-link-missing', '演示数据没有可访问的原始岗位链接'));
    }
    elements.overlay.classList.remove('hidden');
  }

  function closeDetail() { elements.overlay.classList.add('hidden'); }

  function getSelectedKeywordPreset() {
    const active = byId('crawl-keyword-preset')?.querySelector('button[data-value].active');
    const key = active?.dataset.value || state.keywordPreset || 'primary';
    return KEYWORD_PRESETS[key] || KEYWORD_PRESETS.primary;
  }

  function closeSetup() {
    elements.setupOverlay.classList.add('hidden');
  }

  function selectedTracksFromForm(form) {
    return [...form.querySelectorAll('input[name="targetTracks"]:checked')].map((input) => input.value);
  }

  function setupInput(labelText, name, value, attrs = {}) {
    const label = make('label');
    label.append(document.createTextNode(labelText));
    const input = make('input', 'input');
    input.name = name;
    input.value = String(value ?? '');
    Object.entries(attrs).forEach(([key, attrValue]) => {
      if (attrValue !== undefined) input.setAttribute(key, String(attrValue));
    });
    label.append(input);
    return label;
  }

  function setupSelect(labelText, name, options) {
    const label = make('label');
    label.append(document.createTextNode(labelText));
    const select = make('select', 'select');
    select.name = name;
    options.forEach(([value, text]) => {
      const option = make('option', '', text);
      option.value = value;
      select.append(option);
    });
    label.append(select);
    return label;
  }

  function setupTrack(value, text) {
    const label = make('label');
    const input = make('input');
    input.type = 'checkbox';
    input.name = 'targetTracks';
    input.value = value;
    label.append(input, document.createTextNode(` ${text}`));
    return label;
  }

  async function openSetup() {
    const [config, profilePayload] = await Promise.all([api('/api/config'), api('/api/profile')]);
    const settings = config.settings;
    const profile = profilePayload.profile;
    state.settings = settings;
    state.profile = profile;
    const modal = elements.setupModal;
    modal.replaceChildren();
    const close = make('button', 'modal-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', closeSetup);
    const header = make('div', 'modal-header');
    header.append(make('h2', '', '初始设置'), make('p', 'muted', '这些信息只保存在本机，用来决定抓取关键词和评分偏好。'));
    modal.append(close, header);

    const form = make('form', 'setup-form');
    const tracks = make('div', 'setup-tracks');
    tracks.append(
      make('span', '', '目标方向'),
      setupTrack('ai_solutions', 'AI解决方案'),
      setupTrack('ai_product', 'AI产品'),
      setupTrack('ai_customer_success', '客户成功'),
      setupTrack('ai_application', 'AI应用开发'),
    );
    form.append(
      setupInput('城市码', 'cityCode', settings.cityCode || '101010100'),
      setupInput('关键词', 'keywords', (settings.keywords || DEFAULT_KEYWORDS).join(',')),
      setupSelect('求职阶段', 'careerStage', [
        ['experienced', '社招'],
        ['career_change', '转岗'],
        ['new_grad', '应届'],
        ['internship', '实习'],
      ]),
      setupInput('经验年限', 'experienceYears', profile.experienceYears ?? 3, { type: 'number', min: 0, max: 50 }),
      setupInput('最低月薪 K', 'salaryFloorK', profile.salaryFloorK ?? 0, { type: 'number', min: 0, max: 300 }),
      setupInput('期望月薪 K', 'salaryExpectK', profile.salaryExpectK ?? 0, { type: 'number', min: 0, max: 500 }),
      setupInput('偏好城市', 'cities', Object.keys(profile.locationScore || {}).join(',')),
      tracks,
      setupInput('模型 API Base', 'llmBaseURL', settings.llm?.baseURL || ''),
      setupInput('模型名称', 'llmModel', settings.llm?.model || ''),
      setupInput('模型 API Key', 'llmApiKey', '', {
        type: 'password',
        placeholder: settings.llm?.apiKey ? '已配置，留空则保持不变' : '',
      }),
    );
    form.querySelector('[name="careerStage"]').value = profile.careerStage || 'experienced';
    (profile.targetTracks || []).forEach((track) => {
      const checkbox = form.querySelector(`input[name="targetTracks"][value="${track}"]`);
      if (checkbox) checkbox.checked = true;
    });
    const actions = make('div', 'modal-actions');
    const save = make('button', 'btn btn-primary', '保存设置');
    save.type = 'submit';
    const cancel = make('button', 'btn btn-secondary', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', closeSetup);
    actions.append(cancel, save);
    form.append(actions);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      const data = new FormData(form);
      const keywords = String(data.get('keywords') || '').split(',').map((item) => item.trim()).filter(Boolean);
      const cities = String(data.get('cities') || '').split(',').map((item) => item.trim()).filter(Boolean);
      const locationScore = Object.fromEntries(cities.map((city) => [city, 5]));
      const targetTracks = selectedTracksFromForm(form);
      try {
        await api('/api/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            setupCompleted: true,
            cityCode: String(data.get('cityCode') || '101010100').trim(),
            keywords: keywords.length ? keywords : DEFAULT_KEYWORDS,
            llm: {
              enabled: Boolean(String(data.get('llmApiKey') || '').trim() || settings.llm?.apiKey),
              baseURL: String(data.get('llmBaseURL') || settings.llm?.baseURL || '').trim(),
              model: String(data.get('llmModel') || settings.llm?.model || '').trim(),
              apiKey: String(data.get('llmApiKey') || '').trim() || undefined,
            },
          }),
        });
        await api('/api/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            careerStage: data.get('careerStage'),
            targetTracks: targetTracks.length ? targetTracks : ['ai_solutions', 'ai_product', 'ai_customer_success'],
            experienceYears: Number(data.get('experienceYears') || 0),
            salaryFloorK: Number(data.get('salaryFloorK') || 0),
            salaryExpectK: Number(data.get('salaryExpectK') || 0),
            locationScore,
          }),
        });
        closeSetup();
        showStatus('设置已保存');
      } catch (error) {
        showStatus(`设置保存失败：${error.message}`);
      } finally {
        save.disabled = false;
      }
    });
    modal.append(form);
    elements.setupOverlay.classList.remove('hidden');
  }

  async function startCrawl(source) {
    const label = sourceLabels[source] || source;
    const preset = getSelectedKeywordPreset();
    try {
      const run = await api('/api/crawl', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: [source], keywords: preset.keywords || DEFAULT_KEYWORDS, pages: 1 }),
      });
      showStatus(`${label} · ${preset.label}：${run.message}`, true);
      pollStatus({ restore: false });
    } catch (error) { showStatus(`${label} 启动失败：${error.message}`); }
  }

  async function openLogin(source) {
    const label = sourceLabels[source] || source;
    try {
      const result = await api(`/api/login?source=${encodeURIComponent(source)}`, { method: 'POST' });
      showStatus(result.message || `已打开 ${label} 登录页，请完成登录后再抓取`);
    } catch (error) {
      showStatus(`${label} 登录页打开失败：${error.message}`);
    }
  }

  async function startRescore() {
    try {
      const run = await api('/api/rescore', { method: 'POST' });
      showStatus(run.message, true);
      pollStatus({ restore: false });
    } catch (error) { showStatus(`重评失败：${error.message}`); }
  }

  async function pollStatus(options = {}) {
    const { restore = false } = options;
    if (state.polling) return;
    state.polling = true;
    try {
      while (true) {
        const run = await api('/api/status');
        if (!run) { hideStatus(); break; }
        const active = run.status === 'queued' || run.status === 'running';
        if (restore && !active) { hideStatus(); break; }
        const progress = run.totalPages ? ` (${run.currentPage}/${run.totalPages})` : '';
        showStatus(`${run.message}${progress}${run.error ? `：${run.error}` : ''}`, active);
        if (!active) { await loadJobs(); break; }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (error) {
      showStatus(`状态查询失败：${error.message}`);
    } finally { state.polling = false; }
  }

  function selectChip(id, key, value) {
    byId(id).querySelectorAll('button[data-value]').forEach((item) => {
      item.classList.toggle('active', item.dataset.value === value);
    });
    state[key] = value;
  }

  function setupChips(id, key) {
    byId(id).addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button) return;
      selectChip(id, key, button.dataset.value);
      if (id === 'crawl-keyword-preset') {
        const preset = getSelectedKeywordPreset();
        showStatus(`已选择${preset.label}：${preset.keywords.join('、')}`);
        return;
      }
      if (id === 'filter-grade' && state.lifecycle !== 'active') {
        selectChip('filter-lifecycle', 'lifecycle', 'active');
      }
      loadJobs();
    });
  }

  let searchTimer;
  elements.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = elements.search.value.trim(); loadJobs(); }, 250);
  });
  elements.sort.addEventListener('change', () => { state.sort = elements.sort.value; loadJobs(); });
  elements.refresh.addEventListener('click', loadJobs);
  elements.setup.addEventListener('click', () => openSetup().catch((error) => showStatus(`设置加载失败：${error.message}`)));
  elements.loginButtons.forEach((button) => {
    button.addEventListener('click', () => openLogin(button.dataset.loginSource));
  });
  elements.crawlButtons.forEach((button) => {
    button.addEventListener('click', () => startCrawl(button.dataset.crawlSource));
  });
  elements.rescore.addEventListener('click', startRescore);
  elements.overlay.addEventListener('click', (event) => { if (event.target === elements.overlay) closeDetail(); });
  elements.setupOverlay.addEventListener('click', (event) => { if (event.target === elements.setupOverlay) closeSetup(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeDetail();
    closeSetup();
  });
  setupChips('filter-grade', 'grade');
  setupChips('filter-source', 'source');
  setupChips('filter-lifecycle', 'lifecycle');
  setupChips('crawl-keyword-preset', 'keywordPreset');
  api('/api/setup/status')
    .then((status) => { if (!status.configured) return openSetup(); })
    .catch((error) => showStatus(`设置状态检查失败：${error.message}`));
  loadJobs();
  pollStatus({ restore: true });
})();
