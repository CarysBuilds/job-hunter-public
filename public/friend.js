(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const template = byId('friend-template');
  const selected = new Set();
  let jobs = [];
  let preview = null;
  let runId = null;
  let polling = false;
  let busy = false;
  let savedText = '';
  const node = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  async function api(path, body) {
    const response = await fetch(`/api${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-job-hunter-request': '1' }, body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || '请求失败');
    return payload.data;
  }
  const status = (text) => { byId('friend-status').textContent = text; };
  function invalidate() {
    preview = null;
    byId('friend-confirmation').classList.add('hidden');
  }
  function setBusy(value) {
    busy = value;
    template.disabled = value;
    byId('greeting-view').querySelectorAll('button, input').forEach((element) => {
      if (element.id !== 'friend-stop') element.disabled = value;
    });
    byId('friend-stop').classList.toggle('hidden', !value);
  }
  function render() {
    const list = byId('friend-candidates');
    list.replaceChildren();
    jobs.forEach((job) => {
      const row = node('label');
      row.className = 'friend-candidate';
      const check = node('input');
      check.type = 'checkbox';
      check.checked = selected.has(job.id);
      check.disabled = busy;
      check.addEventListener('change', () => {
        if (check.checked && selected.size >= 20) {
          check.checked = false;
          status('每批最多 20 个岗位，请先完成本批。');
          return;
        }
        if (check.checked) selected.add(job.id); else selected.delete(job.id);
        invalidate();
        count();
      });
      row.append(check, node('span', `${job.score.grade} 档 · ${job.title} · ${job.company} · ${job.salary} · ${job.location}`));
      list.append(row);
    });
    if (!jobs.length) list.append(node('p', '暂无可发送的 BOSS A/B 岗位。请先抓取并评分；已沟通或发送待确认的岗位不会重复出现。'));
    count();
  }
  function count() {
    byId('friend-count').textContent = `可选 ${jobs.length} 个（A ${jobs.filter((job) => job.score.grade === 'A').length} / B ${jobs.filter((job) => job.score.grade === 'B').length}），已选 ${selected.size}/20 个`;
  }
  async function refresh() {
    const data = await api('/greeting/candidates');
    jobs = data.jobs;
    selected.clear();
    invalidate();
    render();
  }
  function selectGrades(grades) {
    selected.clear();
    const matches = jobs.filter((job) => grades.includes(job.score.grade));
    matches.slice(0, 20).forEach((job) => selected.add(job.id));
    invalidate();
    render();
    if (matches.length > 20) status(`符合条件 ${matches.length} 个，本批选择排序靠前的 20 个，可逐项调整。`);
  }
  async function poll() {
    if (polling || !runId) return;
    polling = true;
    try {
      while (runId) {
        const data = await api(`/runs/${encodeURIComponent(runId)}`);
        const active = ['running', 'queued'].includes(data.run.status);
        setBusy(active);
        status(`${data.run.message}${data.run.error ? `：${data.run.error}` : ''}`);
        byId('friend-results').replaceChildren(...data.greetingAttempts.map((attempt) => {
          const job = jobs.find((item) => item.id === attempt.jobId);
          return node('p', `${attempt.title || job?.title || attempt.jobId}${attempt.company ? ` · ${attempt.company}` : ''}：${attempt.state === 'sent' ? '已发送' : '发送待确认'} — ${attempt.detail}`);
        }));
        if (!active) { runId = null; await refresh(); break; }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (error) {
      status(`状态查询失败，发送可能仍在进行。请点击“重新连接任务”查看：${error.message}`);
      byId('friend-reconnect').classList.remove('hidden');
      byId('friend-reconnect').disabled = false;
    } finally { polling = false; }
  }
  function bind(id, action) {
    byId(id).addEventListener('click', async () => {
      const button = byId(id);
      button.disabled = true;
      try { await action(); } catch (error) { status(error.message); }
      finally { button.disabled = busy && id !== 'friend-stop' && id !== 'friend-reconnect'; }
    });
  }
  template.addEventListener('input', invalidate);
  bind('friend-save', async () => {
    const text = template.value.trim();
    if (!text || text.length > 500) throw new Error('请填写 1–500 个字符的模板');
    const response = await fetch('/api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-job-hunter-request': '1' },
      body: JSON.stringify({ greetingTemplate: text }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || '保存失败');
    savedText = text;
    template.value = text;
    invalidate();
    status('模板已保存到本机。');
  });
  bind('friend-refresh', refresh);
  bind('friend-select-a', () => selectGrades(['A']));
  bind('friend-select-b', () => selectGrades(['B']));
  bind('friend-select-ab', () => selectGrades(['A', 'B']));
  bind('friend-clear', () => selectGrades([]));
  bind('friend-preview', async () => {
    if (template.value.trim() !== savedText) throw new Error('模板有修改，请先保存后再预览');
    const data = await api('/greeting/preview', { jobIds: [...selected] });
    preview = data;
    byId('friend-preview-text').textContent = data.text;
    byId('friend-preview-jobs').replaceChildren(...data.jobs.map((job) => node('li', `${job.score.grade} 档 · ${job.title} · ${job.company}`)));
    byId('friend-confirmation').classList.remove('hidden');
    byId('friend-confirmation').scrollIntoView({ block: 'nearest' });
  });
  bind('friend-send', async () => {
    if (!preview) throw new Error('请重新预览');
    const token = preview.token;
    invalidate();
    setBusy(true);
    try {
      const run = await api('/greeting/batch', { token, confirm: true });
      runId = run.id;
      void poll();
    } catch (error) {
      setBusy(false);
      throw error;
    }
  });
  bind('friend-stop', async () => {
    if (runId) { await api(`/runs/${encodeURIComponent(runId)}/cancel`, {}); status('已请求停止，等待当前岗位核对结束。'); }
  });
  bind('friend-reconnect', async () => {
    byId('friend-reconnect').classList.add('hidden');
    if (!runId) {
      const run = await api('/status');
      if (run?.operation === 'greeting') runId = run.id;
    }
    await poll();
  });
  async function initialize() {
    const config = await api('/config');
    savedText = config.settings.greetingTemplate || '';
    template.value = savedText;
    await refresh();
    const run = await api('/status');
    if (run?.operation === 'greeting') { runId = run.id; void poll(); }
  }
  initialize().catch((error) => status(`加载失败：${error.message}`));
})();
