// ==UserScript==
// @name         BOSS 岗位追踪台
// @name:en      BOSS Job Tracker
// @namespace    sherry.boss.tracker
// @version      1.2.1
// @description  自动采集你关注企业在 BOSS直聘 上的在招岗位，汇总看板 + 新岗位高亮 + 投递状态追踪
// @description:en  Auto-collect job postings from companies you follow on BOSS Zhipin, then review them in a local dashboard with application status tracking.
// @author       Sherry
// @license      MIT
// @homepageURL  https://github.com/zxr0803/boss-job-tracker
// @supportURL   https://github.com/zxr0803/boss-job-tracker/issues
// @updateURL    https://raw.githubusercontent.com/zxr0803/boss-job-tracker/main/boss-job-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/zxr0803/boss-job-tracker/main/boss-job-tracker.user.js
// @match        https://www.zhipin.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 使用说明
 * 1. 浏览器安装 Tampermonkey 扩展，新建脚本，把本文件全部内容粘贴进去并保存。
 * 2. 打开 BOSS直聘，右下角会出现「追踪」悬浮球，先点开 → 企业页签 → 添加你要关注的公司（名字写全称或常用简称皆可）。
 * 3. 之后你正常刷 BOSS（搜索结果页、公司职位页），脚本会自动把关注企业的岗位记下来。
 * 4. 岗位卡片上会出现状态角标，7 天内首次发现的高亮为橙色边框；点悬浮球看汇总看板。
 * 5. 所有数据只存在你自己的浏览器里，脚本不会向任何服务器发送数据。
 */

(function () {
  'use strict';

  /* ==================== 常量 ==================== */
  const KEY = 'bossTracker_state_v1';
  const NEW_DAYS = 7;
  const DAY = 86400000;

  const STATUS_LIST = [
    { key: 'todo',      label: '待看',   fg: '#5F5E5A', bg: '#F1EFE8' },
    { key: 'applied',   label: '已投递', fg: '#185FA5', bg: '#E6F1FB' },
    { key: 'chat',      label: '已沟通', fg: '#854F0B', bg: '#FAEEDA' },
    { key: 'pending',   label: '待面试', fg: '#534AB7', bg: '#EEEDFE' },
    { key: 'interview', label: '已面试', fg: '#0F6E56', bg: '#E1F5EE' },
    { key: 'offer',     label: 'Offer',  fg: '#3B6D11', bg: '#EAF3DE' },
    { key: 'closed',    label: '已结束', fg: '#888780', bg: '#F1EFE8' }
  ];
  const STATUS_MAP = {};
  STATUS_LIST.forEach(function (s) { STATUS_MAP[s.key] = s; });

  /* ==================== 存储 ==================== */
  function readState() {
    let raw = null;
    try {
      raw = (typeof GM_getValue === 'function') ? GM_getValue(KEY, null) : localStorage.getItem(KEY);
    } catch (e) { raw = null; }
    let s = null;
    if (typeof raw === 'string') { try { s = JSON.parse(raw); } catch (e) { s = null; } }
    else if (raw && typeof raw === 'object') s = raw;
    return normalize(s);
  }

  function writeState(s) {
    const raw = JSON.stringify(s);
    try {
      if (typeof GM_setValue === 'function') GM_setValue(KEY, raw);
      else localStorage.setItem(KEY, raw);
    } catch (e) {
      try { localStorage.setItem(KEY, raw); } catch (e2) { /* ignore */ }
    }
  }

  function normalize(s) {
    s = s || {};
    const st = Object.assign({
      keywords: ['HRBP', '招聘', '人力资源', '组织发展', '校招', '培训'],
      onlyTracked: true,
      autoCollect: true
    }, s.settings || {});
    return {
      version: 1,
      jobs: (s.jobs && typeof s.jobs === 'object') ? s.jobs : {},
      companies: Array.isArray(s.companies) ? s.companies : [],
      settings: st
    };
  }

  /* ==================== 工具 ==================== */
  function normName(str) {
    return String(str || '')
      .replace(/[\s\u3000]/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/有限公司|有限责任公司|股份有限公司|集团有限公司|分公司|集团|控股/g, '')
      .toLowerCase();
  }

  function jobIdFromHref(href) {
    if (!href) return '';
    let m = /\/job_detail\/([^./?#]+)\.html/.exec(href);
    if (m) return m[1];
    m = /[?&]jobId=([^&#]+)/.exec(href);
    if (m) return decodeURIComponent(m[1]);
    return '';
  }

  function daysAgo(ts) {
    if (!ts) return 9999;
    return (Date.now() - ts) / DAY;
  }

  const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '武汉', '西安',
    '长沙', '重庆', '天津', '合肥', '宁波', '青岛', '郑州', '无锡', '厦门', '福州', '济南',
    '东莞', '佛山', '珠海', '昆明', '大连', '沈阳', '哈尔滨', '南昌', '贵阳', '南宁', '石家庄',
    '太原', '长春', '兰州', '海口', '温州', '嘉兴', '绍兴', '金华', '台州', '湖州'];

  const EXP_FILTERS = [
    { key: 'intern', label: '实习' },
    { key: 'campus', label: '校招' },
    { key: 'y1_3',   label: '1-3年' },
    { key: 'y3_5',   label: '3-5年' },
    { key: 'y5_10',  label: '5-10年' },
    { key: 'y10',    label: '10年以上' },
    { key: 'none',   label: '经验不限' }
  ];
  const EXP_LABEL = {};
  EXP_FILTERS.forEach(function (e) { EXP_LABEL[e.key] = e.label; });

  function cityOf(job) {
    const a = job.area || '';
    if (a) {
      const first = a.split(/[·・\-—\s]/)[0];
      if (first) return first;
    }
    const tags = job.tags || [];
    for (let i = 0; i < tags.length; i++) {
      for (let k = 0; k < CITIES.length; k++) {
        if (tags[i].indexOf(CITIES[k]) !== -1) return CITIES[k];
      }
    }
    return '';
  }

  function expKeyOf(job) {
    const salary = job.salary || '';
    const title = job.title || '';
    const tagStr = (job.tags || []).join(' ');
    const all = title + ' ' + tagStr + ' ' + salary;

    if (/实习/.test(title) || /实习/.test(tagStr) || /元\/[天日]/.test(salary) || /\/天/.test(salary)) return 'intern';
    if (/校招|应届|在校|管培|校园/.test(all)) return 'campus';

    if (/10年以上/.test(tagStr)) return 'y10';
    if (/5-10年|5—10年/.test(tagStr)) return 'y5_10';
    if (/3-5年|3—5年/.test(tagStr)) return 'y3_5';
    if (/1-3年|1—3年|1年以内|1年以下/.test(tagStr)) return 'y1_3';

    if (/10年以上/.test(all)) return 'y10';
    if (/5-10年/.test(all)) return 'y5_10';
    if (/3-5年/.test(all)) return 'y3_5';
    if (/1-3年|1年以内|1年以下/.test(all)) return 'y1_3';

    return 'none';
  }

  function expLabelOf(job) {
    return EXP_LABEL[expKeyOf(job)] || '—';
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() {
    return 'c' + Math.random().toString(36).slice(2, 9);
  }

  /* ==================== 采集 ==================== */
  function pickText(root, sels) {
    for (let i = 0; i < sels.length; i++) {
      try {
        const el = root.querySelector(sels[i]);
        if (el) {
          const t = (el.innerText || el.textContent || '').trim();
          if (t) return t;
        }
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  function currentCompanyName() {
    const direct = pickText(document, [
      '.company-info h1', '[class*="company-name"] h1', '[class*="company-title"]',
      '.info-primary h1', 'h1[class*="name"]'
    ]);
    if (direct) return direct.replace(/\s+/g, ' ').trim();
    const t = document.title || '';
    const m = t.match(/^(.+?)[（(\-—|｜]/);
    return m ? m[1].trim() : '';
  }

  function extractJobs() {
    const anchors = Array.prototype.slice.call(
      document.querySelectorAll('a[href*="/job_detail"], a[href*="jobId="]')
    );
    const out = [];
    const seen = {};
    const pageCompany = currentCompanyName();

    anchors.forEach(function (a) {
      const href = a.getAttribute('href') || '';
      const id = jobIdFromHref(href);
      if (!id) return;
      if (seen[id]) return;

      const card = a.closest('li') || a.closest('[class*="job-card"]') ||
                   (a.parentElement && a.parentElement.parentElement) || a;
      const raw = (card.innerText || '').trim();
      if (raw.length < 8) return;
      seen[id] = true;

      const lines = raw.split('\n').map(function (t) { return t.trim(); }).filter(Boolean);

      let title = pickText(card, ['[class*="job-name"]', '.job-name', '[class*="job-title"]']);
      if (!title) {
        const alt = (a.innerText || '').split('\n')[0].trim();
        title = alt || lines[0] || '';
      }

      let salary = pickText(card, ['[class*="salary"]', '.salary', '[class*="red"]']);
      if (!salary) {
        const sm = raw.match(/\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*(?:K|k|千|万|元)|\d{2,4}\s*-\s*\d{2,4}\s*元\/[天月]/);
        salary = sm ? sm[0] : '';
      }

      const area = pickText(card, ['[class*="job-area"]', '.job-area', '[class*="location"]']);

      let company = pickText(card, [
        '[class*="company-name"]', 'h3.company-name', '[class*="company-title"]',
        '[class*="brand-name"]'
      ]);
      if (!company && pageCompany) company = pageCompany;
      company = company.replace(/\s+/g, ' ').trim();

      const tags = Array.prototype.slice
        .call(card.querySelectorAll('[class*="tag-list"] li, [class*="tag-list"] span, [class*="job-tags"] span'))
        .map(function (e) { return (e.innerText || '').trim(); })
        .filter(Boolean)
        .slice(0, 8);

      const tm = raw.match(/(刚刚|\d+\s*分钟前|\d+\s*小时前|昨天|前天|\d+\s*天前|\d{1,2}月\d{1,2}日)/);
      const platformTime = tm ? tm[1].replace(/\s/g, '') : '';

      let link = href;
      try { link = new URL(href, location.origin).href.split('?')[0]; } catch (e) { /* ignore */ }

      out.push({
        id: id,
        title: title,
        company: company,
        salary: salary,
        area: area,
        tags: tags,
        link: link,
        platformTime: platformTime
      });
    });

    return out;
  }

  function matchCompany(name, state) {
    if (!name) return null;
    const n = normName(name);
    if (!n) return null;
    for (let i = 0; i < state.companies.length; i++) {
      const c = state.companies[i];
      const cands = [c.name].concat(c.aliases || []);
      for (let k = 0; k < cands.length; k++) {
        const cand = normName(cands[k]);
        if (!cand || cand.length < 2) continue;
        if (n.indexOf(cand) !== -1 || cand.indexOf(n) !== -1) return c;
      }
    }
    return null;
  }

  function markStar(state) {
    const kws = (state.settings.keywords || []).filter(Boolean).map(function (k) { return k.toLowerCase(); });
    Object.keys(state.jobs).forEach(function (id) {
      const job = state.jobs[id];
      const hay = (job.title + ' ' + (job.tags || []).join(' ')).toLowerCase();
      job.starred = kws.some(function (k) { return hay.indexOf(k) !== -1; });
    });
  }

  let lastWriteAt = 0;

  function scan() {
    const state = readState();
    if (!state.settings.autoCollect) return { added: 0, updated: 0, total: 0, skipped: true };

    const list = extractJobs();
    const now = Date.now();
    let added = 0, updated = 0;

    list.forEach(function (j) {
      const comp = matchCompany(j.company, state);
      if (state.settings.onlyTracked && !comp) return;
      const exist = state.jobs[j.id];
      if (exist) {
        exist.lastSeen = now;
        if (!exist.salary && j.salary) exist.salary = j.salary;
        if (!exist.company && j.company) exist.company = j.company;
        if (!exist.area && j.area) exist.area = j.area;
        if (j.platformTime) exist.platformTime = j.platformTime;
        if (comp && !exist.companyId) exist.companyId = comp.id;
        updated++;
      } else {
        state.jobs[j.id] = {
          id: j.id,
          title: j.title,
          company: j.company,
          companyId: comp ? comp.id : '',
          salary: j.salary,
          area: j.area,
          tags: j.tags,
          link: j.link,
          platformTime: j.platformTime,
          firstSeen: now,
          lastSeen: now,
          status: 'todo',
          note: '',
          starred: false,
          from: location.pathname
        };
        added++;
      }
    });

    markStar(state);
    if (added > 0 || Date.now() - lastWriteAt > 60000) {
      writeState(state);
      lastWriteAt = Date.now();
    }
    if (added > 0) toast('已记录 ' + added + ' 个新岗位');
    return { added: added, updated: updated, total: list.length };
  }

  /* ==================== 样式 ==================== */
  const CSS = [
    '#bt-orb{position:fixed;right:22px;bottom:22px;width:52px;height:52px;border-radius:50%;',
    'background:#0F6E56;color:#fff;display:flex;align-items:center;justify-content:center;',
    'font:500 12px/1.2 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer;',
    'z-index:2147482000;box-shadow:0 4px 16px rgba(15,110,86,.35);user-select:none;letter-spacing:.5px}',
    '#bt-orb:hover{background:#0b5945}',
    '#bt-orb .bt-orb-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;',
    'border-radius:9px;background:#D85A30;color:#fff;font-size:11px;line-height:18px;text-align:center}',
    '#bt-mask{position:fixed;inset:0;background:rgba(20,20,20,.28);z-index:2147482900}',
    '#bt-panel{position:fixed;top:0;right:0;bottom:0;width:min(900px,100vw);background:#fff;z-index:2147483000;',
    'display:flex;flex-direction:column;box-shadow:-8px 0 32px rgba(0,0,0,.14);',
    'font:400 13px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1a1a1a}',
    '#bt-panel *{box-sizing:border-box}',
    '.bt-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 12px}',
    '.bt-head h1{font-size:16px;font-weight:500;margin:0}',
    '.bt-head .bt-sub{font-size:12px;color:#8a8a8a;margin-top:2px}',
    '.bt-close{cursor:pointer;font-size:22px;color:#999;line-height:1;padding:2px 6px;border-radius:6px}',
    '.bt-close:hover{background:#f2f2f2;color:#333}',
    '.bt-tabs{display:flex;gap:4px;padding:0 20px;border-bottom:1px solid #eee}',
    '.bt-tab{padding:8px 12px;font-size:13px;color:#666;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}',
    '.bt-tab:hover{color:#222}',
    '.bt-tab.on{color:#0F6E56;border-bottom-color:#0F6E56;font-weight:500}',
    '.bt-body{flex:1;overflow:auto;padding:16px 20px 40px}',
    '.bt-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}',
    '.bt-metric{background:#f7f7f5;border-radius:10px;padding:12px}',
    '.bt-metric .k{font-size:12px;color:#888}',
    '.bt-metric .v{font-size:24px;font-weight:500;font-family:ui-monospace,Menlo,Consolas,monospace;margin-top:2px}',
    '.bt-card{background:#fff;border:1px solid #eee;border-radius:12px;padding:14px 16px;margin-bottom:14px}',
    '.bt-card h2{font-size:13px;font-weight:500;margin:0 0 10px;color:#333}',
    '.bt-bars{display:flex;align-items:flex-end;gap:8px;height:96px;padding-top:6px}',
    '.bt-bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;height:100%}',
    '.bt-bar i{display:block;width:100%;background:#5DCAA5;border-radius:4px 4px 0 0;min-height:2px}',
    '.bt-bar span{font-size:11px;color:#999;font-family:ui-monospace,monospace}',
    '.bt-bar em{font-size:11px;color:#666;font-style:normal}',
    '.bt-banner{background:#E6F1FB;color:#185FA5;border-radius:10px;padding:9px 14px;margin-bottom:14px;',
    'display:flex;justify-content:space-between;align-items:center;font-size:12.5px;cursor:pointer}',
    '.bt-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f2f2f2}',
    '.bt-row:last-child{border-bottom:none}',
    '.bt-row .tit{flex:1;min-width:0}',
    '.bt-row .tit b{font-weight:500;font-size:13px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bt-row .tit small{font-size:11.5px;color:#999;display:block;margin-top:1px}',
    '.bt-chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:5px;white-space:nowrap}',
    '.bt-newdot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#D85A30;margin-right:5px;vertical-align:1px}',
    '.bt-star{color:#BA7517;margin-right:4px}',
    '.bt-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
    '.bt-filters input[type=text],.bt-filters select{border:1px solid #e2e2e2;border-radius:8px;padding:6px 10px;',
    'font-size:12.5px;outline:none;background:#fff;font-family:inherit}',
    '.bt-filters input[type=text]{flex:1;min-width:140px}',
    '.bt-filters input[type=text]:focus,.bt-filters select:focus{border-color:#5DCAA5}',
    '.bt-btn{border:1px solid #ddd;background:#fff;border-radius:8px;padding:6px 12px;font-size:12.5px;',
    'cursor:pointer;font-family:inherit;color:#333}',
    '.bt-btn:hover{background:#f7f7f5;border-color:#ccc}',
    '.bt-btn.primary{background:#0F6E56;border-color:#0F6E56;color:#fff}',
    '.bt-btn.primary:hover{background:#0b5945}',
    '.bt-btn.danger{color:#A32D2D;border-color:#f0d5d5}',
    '.bt-btn.danger:hover{background:#FCEBEB}',
    '.bt-status-sel{border:1px solid #e2e2e2;border-radius:6px;font-size:11.5px;padding:2px 4px;',
    'background:#fff;font-family:inherit;color:#444;cursor:pointer}',
    '.bt-del{padding:1px 8px 3px;font-size:15px;line-height:1.2;color:#c4c4c4;border-color:#eee;flex:none}',
    '.bt-del:hover{color:#A32D2D;background:#FCEBEB;border-color:#f0d5d5}',
    '.bt-empty{text-align:center;color:#aaa;padding:48px 20px;font-size:13px;line-height:1.9}',
    '.bt-empty b{display:block;color:#666;font-size:14px;font-weight:500;margin-bottom:6px}',
    '.bt-toggle{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#444;margin:8px 0}',
    '.bt-toggle input{width:15px;height:15px;accent-color:#0F6E56;cursor:pointer}',
    '.bt-kw{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
    '.bt-kw span{background:#EEEDFE;color:#534AB7;font-size:12px;padding:3px 9px;border-radius:6px;cursor:pointer}',
    '.bt-kw span:hover{background:#e2dffd;text-decoration:line-through}',
    '.bt-bar-line{height:1px;background:#f0f0f0;margin:16px 0}',
    '.bt-mini{font-size:12px;color:#999;margin-top:4px}',
    '#bt-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:90px;background:#1a1a1a;color:#fff;',
    'padding:8px 16px;border-radius:20px;font-size:12.5px;z-index:2147483600;opacity:0;transition:opacity .2s}',
    '#bt-toast.on{opacity:1}',
    'li.bt-new{outline:2px solid #EF9F27 !important;outline-offset:-2px;border-radius:10px}'
  ].join('');

  /* ==================== 面板 ==================== */
  let ui = { root: null, tab: 'overview', filter: { q: '', company: '', status: '', city: '', exp: '', onlyNew: false } };

  function toast(msg) {
    let t = document.getElementById('bt-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'bt-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('on'); }, 2000);
  }

  function injectStyle() {
    if (document.getElementById('bt-style')) return;
    const s = document.createElement('style');
    s.id = 'bt-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function buildPanel() {
    if (document.getElementById('bt-panel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'bt-root';
    wrap.innerHTML =
      '<div id="bt-mask"></div>' +
      '<div id="bt-panel">' +
        '<div class="bt-head">' +
          '<div><h1>BOSS 岗位追踪台</h1><div class="bt-sub" id="bt-sub"></div></div>' +
          '<div class="bt-close" id="bt-close">×</div>' +
        '</div>' +
        '<div class="bt-tabs">' +
          '<div class="bt-tab on" data-tab="overview">概览</div>' +
          '<div class="bt-tab" data-tab="jobs">岗位</div>' +
          '<div class="bt-tab" data-tab="companies">企业</div>' +
          '<div class="bt-tab" data-tab="settings">设置</div>' +
        '</div>' +
        '<div class="bt-body" id="bt-body"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    ui.root = wrap;

    document.getElementById('bt-close').addEventListener('click', closePanel);
    document.getElementById('bt-mask').addEventListener('click', closePanel);
    document.getElementById('bt-mask').style.display = 'none';
    wrap.querySelectorAll('.bt-tab').forEach(function (el) {
      el.addEventListener('click', function () {
        ui.tab = el.getAttribute('data-tab');
        wrap.querySelectorAll('.bt-tab').forEach(function (x) { x.classList.remove('on'); });
        el.classList.add('on');
        render();
      });
    });
    document.getElementById('bt-body').addEventListener('change', onBodyChange);
    document.getElementById('bt-body').addEventListener('click', onBodyClick);
    document.getElementById('bt-body').addEventListener('input', onBodyInput);
    document.getElementById('bt-body').addEventListener('keydown', onBodyKeydown);
    document.getElementById('bt-body').addEventListener('compositionstart', onCompositionStart);
    document.getElementById('bt-body').addEventListener('compositionend', onCompositionEnd);
  }

  let composing = false;
  let inputTimer = null;

  function onCompositionStart() {
    composing = true;
  }

  function onCompositionEnd(e) {
    composing = false;
    if (e.target && e.target.id === 'bt-q') {
      clearTimeout(inputTimer);
      applyQuery(e.target.value);
    }
  }

  function onBodyInput(e) {
    if (e.target.id !== 'bt-q') return;
    if (composing) return;
    const val = e.target.value;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(function () { applyQuery(val); }, 180);
  }

  function applyQuery(val) {
    ui.filter.q = val;
    render();
    const el = document.getElementById('bt-q');
    if (el) {
      el.focus();
      const n = el.value.length;
      try { el.setSelectionRange(n, n); } catch (err) { /* ignore */ }
    }
  }

  function onBodyKeydown(e) {
    if (e.isComposing || composing) return;
    if (e.key !== 'Enter') return;
    const id = e.target.id;
    if (id === 'bt-c-name') {
      e.preventDefault();
      const btn = document.querySelector('[data-act="add-company"]');
      if (btn) btn.click();
    } else if (id === 'bt-kw-new') {
      e.preventDefault();
      const btn = document.querySelector('[data-act="add-kw"]');
      if (btn) btn.click();
    } else if (id === 'bt-q') {
      e.preventDefault();
    }
  }

  function openPanel(tab) {
    buildPanel();
    if (!ui.root) ui.root = document.getElementById('bt-root');
    if (tab) {
      ui.tab = tab;
      ui.root.querySelectorAll('.bt-tab').forEach(function (x) {
        x.classList.toggle('on', x.getAttribute('data-tab') === tab);
      });
    }
    document.getElementById('bt-mask').style.display = 'block';
    document.getElementById('bt-panel').style.display = 'flex';
    render();
  }

  function closePanel() {
    const mask = document.getElementById('bt-mask');
    const panel = document.getElementById('bt-panel');
    if (mask) mask.style.display = 'none';
    if (panel) panel.style.display = 'none';
  }

  function render() {
    const state = readState();
    const body = document.getElementById('bt-body');
    if (!body) return;
    const jobs = Object.keys(state.jobs).map(function (k) { return state.jobs[k]; })
      .filter(function (j) { return !j.hidden; });
    const newCount = jobs.filter(function (j) { return daysAgo(j.firstSeen) <= NEW_DAYS; }).length;
    const sub = document.getElementById('bt-sub');
    if (sub) {
      sub.textContent = state.companies.length + ' 家关注企业 · ' + jobs.length + ' 个岗位 · ' +
        newCount + ' 个近 7 天新增';
    }
    if (ui.tab === 'overview') body.innerHTML = viewOverview(state, jobs);
    else if (ui.tab === 'jobs') body.innerHTML = viewJobs(state, jobs);
    else if (ui.tab === 'companies') body.innerHTML = viewCompanies(state, jobs);
    else body.innerHTML = viewSettings(state, jobs);
    updateOrb();
  }

  /* ---- 概览 ---- */
  function viewOverview(state, jobs) {

    const weekJobs = jobs.filter(function (j) { return daysAgo(j.firstSeen) <= NEW_DAYS; });
    const cnt = {};
    STATUS_LIST.forEach(function (s) { cnt[s.key] = 0; });
    jobs.forEach(function (j) { cnt[j.status] = (cnt[j.status] || 0) + 1; });
    const weekStar = weekJobs.filter(function (j) { return j.starred; }).length;

    const html = [];
    if (weekJobs.length > 0) {
      html.push('<div class="bt-banner" data-act="focus-new"><span>近 7 天有 ' + weekJobs.length +
        ' 个新岗位上架' + (weekStar ? '，其中 ' + weekStar + ' 个命中关键词' : '') +
        '</span><span>只看新增 →</span></div>');
    }

    html.push('<div class="bt-grid">');
    html.push(metric('在招岗位', jobs.length));
    html.push(metric('近 7 天新增', weekJobs.length, '#BA7517'));
    html.push(metric('待跟进', (cnt.applied || 0) + (cnt.chat || 0), '#185FA5'));
    html.push(metric('面试 / Offer', (cnt.pending || 0) + (cnt.interview || 0) + (cnt.offer || 0), '#534AB7'));
    html.push('</div>');

    html.push('<div class="bt-card"><h2>近 7 天新增走势</h2>' + barChart(jobs) + '</div>');

    const byCompany = groupByCompany(state, jobs);
    html.push('<div class="bt-card"><h2>企业活跃度</h2>');
    if (!byCompany.length) {
      html.push('<div class="bt-mini">还没有数据。先去「企业」页添加关注公司，然后正常刷 BOSS。</div>');
    } else {
      byCompany.slice(0, 8).forEach(function (g) {
        const nw = g.jobs.filter(function (j) { return daysAgo(j.firstSeen) <= NEW_DAYS; }).length;
        html.push('<div class="bt-row"><div class="tit"><b>' + esc(g.name) +
          (nw ? ' <span class="bt-chip" style="background:#FAEEDA;color:#854F0B">NEW ' + nw + '</span>' : '') +
          '</b><small>最近更新 ' + fmtDate(g.lastSeen) + '</small></div>' +
          '<div class="bt-chip" style="background:#F1EFE8;color:#5F5E5A">' + g.jobs.length + ' 个在招</div></div>');
      });
    }
    html.push('</div>');

    const recent = jobs.slice().sort(function (a, b) { return b.firstSeen - a.firstSeen; }).slice(0, 8);
    html.push('<div class="bt-card"><h2>最近记录</h2>');
    if (!recent.length) {
      html.push('<div class="bt-mini">暂无记录。</div>');
    } else {
      recent.forEach(function (j) {
        html.push('<div class="bt-row"><div class="tit"><b>' +
          (daysAgo(j.firstSeen) <= NEW_DAYS ? '<span class="bt-newdot"></span>' : '') +
          esc(j.title) + '</b><small>' + esc(j.company || '—') + ' · 记录于 ' + fmtDate(j.firstSeen) +
          (j.platformTime ? ' · 平台显示 ' + esc(j.platformTime) : '') + '</small></div>' +
          statusChip(j.status) + '</div>');
      });
    }
    html.push('</div>');
    return html.join('');
  }

  function metric(k, v, color) {
    return '<div class="bt-metric"><div class="k">' + k + '</div><div class="v"' +
      (color ? ' style="color:' + color + '"' : '') + '>' + v + '</div></div>';
  }

  function barChart(jobs) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setTime(d.getTime() - i * DAY);
      const start = d.getTime();
      const end = start + DAY;
      const n = jobs.filter(function (j) { return j.firstSeen >= start && j.firstSeen < end; }).length;
      days.push({ label: (d.getMonth() + 1) + '/' + d.getDate(), n: n });
    }
    const max = Math.max.apply(null, days.map(function (d) { return d.n; }).concat([1]));
    let h = '<div class="bt-bars">';
    days.forEach(function (d) {
      const pct = Math.round((d.n / max) * 100);
      h += '<div class="bt-bar"><em>' + (d.n || '') + '</em><i style="height:' +
        Math.max(pct, 2) + '%"></i><span>' + d.label + '</span></div>';
    });
    h += '</div>';
    return h;
  }

  function groupByCompany(state, jobs) {
    const map = {};
    jobs.forEach(function (j) {
      const key = j.company || '未识别企业';
      if (!map[key]) map[key] = { name: key, jobs: [], lastSeen: 0 };
      map[key].jobs.push(j);
      map[key].lastSeen = Math.max(map[key].lastSeen, j.lastSeen || 0);
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.lastSeen - a.lastSeen; });
  }

  function statusChip(key) {
    const s = STATUS_MAP[key] || STATUS_LIST[0];
    return '<span class="bt-chip" style="background:' + s.bg + ';color:' + s.fg + '">' + s.label + '</span>';
  }

  /* ---- 岗位 ---- */
  function viewJobs(state, jobs) {
    const f = ui.filter;
    let list = jobs.slice();
    if (f.q) {
      const q = f.q.toLowerCase();
      list = list.filter(function (j) {
        return (j.title + ' ' + (j.company || '') + ' ' + (j.tags || []).join(' ')).toLowerCase().indexOf(q) !== -1;
      });
    }
    if (f.company) list = list.filter(function (j) { return j.company === f.company; });
    if (f.city) list = list.filter(function (j) { return cityOf(j) === f.city; });
    if (f.exp) list = list.filter(function (j) { return expKeyOf(j) === f.exp; });
    if (f.status) list = list.filter(function (j) { return j.status === f.status; });
    if (f.onlyNew) list = list.filter(function (j) { return daysAgo(j.firstSeen) <= NEW_DAYS; });
    list.sort(function (a, b) { return (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.firstSeen - a.firstSeen; });

    const companyOpts = ['<option value="">全部企业</option>'].concat(
      groupByCompany(state, jobs).map(function (g) {
        return '<option value="' + esc(g.name) + '"' + (f.company === g.name ? ' selected' : '') + '>' +
          esc(g.name) + ' (' + g.jobs.length + ')</option>';
      })
    ).join('');

    const statusOpts = ['<option value="">全部状态</option>'].concat(
      STATUS_LIST.map(function (s) {
        return '<option value="' + s.key + '"' + (f.status === s.key ? ' selected' : '') + '>' + s.label + '</option>';
      })
    ).join('');

    const cityCount = {};
    jobs.forEach(function (j) {
      const c = cityOf(j);
      if (c) cityCount[c] = (cityCount[c] || 0) + 1;
    });
    const cityOpts = ['<option value="">全部地点</option>'].concat(
      Object.keys(cityCount)
        .sort(function (a, b) { return cityCount[b] - cityCount[a]; })
        .map(function (c) {
          return '<option value="' + esc(c) + '"' + (f.city === c ? ' selected' : '') + '>' +
            esc(c) + ' (' + cityCount[c] + ')</option>';
        })
    ).join('');

    const expCount = {};
    jobs.forEach(function (j) {
      const k = expKeyOf(j);
      expCount[k] = (expCount[k] || 0) + 1;
    });
    const expOpts = ['<option value="">全部年限</option>'].concat(
      EXP_FILTERS.filter(function (e) { return expCount[e.key]; }).map(function (e) {
        return '<option value="' + e.key + '"' + (f.exp === e.key ? ' selected' : '') + '>' +
          e.label + ' (' + expCount[e.key] + ')</option>';
      })
    ).join('');

    const h = [];
    h.push('<div class="bt-filters">' +
      '<input type="text" id="bt-q" placeholder="搜岗位 / 公司 / 标签" value="' + esc(f.q) + '">' +
      '<select id="bt-f-city">' + cityOpts + '</select>' +
      '<select id="bt-f-exp">' + expOpts + '</select>' +
      '<select id="bt-f-company">' + companyOpts + '</select>' +
      '<select id="bt-f-status">' + statusOpts + '</select>' +
      '<label class="bt-toggle" style="margin:0"><input type="checkbox" id="bt-f-new"' +
      (f.onlyNew ? ' checked' : '') + '> 只看新增</label>' +
      '</div>');

    h.push('<div class="bt-mini" style="margin-bottom:8px">共 ' + list.length + ' 个岗位</div>');

    if (!list.length) {
      h.push('<div class="bt-empty"><b>没有匹配的岗位</b>换个筛选条件，或者先去 BOSS 上刷一圈让你关注的公司</div>');
      return h.join('');
    }

    list.forEach(function (j) {
      const st = STATUS_MAP[j.status] || STATUS_LIST[0];
      const opts = STATUS_LIST.map(function (s) {
        return '<option value="' + s.key + '"' + (j.status === s.key ? ' selected' : '') + '>' + s.label + '</option>';
      }).join('');
      h.push('<div class="bt-row" data-id="' + esc(j.id) + '">' +
        '<div class="tit"><b>' +
        (daysAgo(j.firstSeen) <= NEW_DAYS ? '<span class="bt-newdot"></span>' : '') +
        (j.starred ? '<span class="bt-star">★</span>' : '') +
        '<a href="' + esc(j.link) + '" target="_blank" style="color:inherit;text-decoration:none">' +
        esc(j.title) + '</a></b>' +
        '<small>' + esc(j.company || '未识别') + (j.area ? ' · ' + esc(j.area) : '') +
        (j.salary ? ' · ' + esc(j.salary) : '') +
        ' · ' + expLabelOf(j) +
        ' · 记录于 ' + fmtDate(j.firstSeen) +
        (j.platformTime ? ' · 平台 ' + esc(j.platformTime) : '') + '</small></div>' +
        '<select class="bt-status-sel" data-id="' + esc(j.id) + '" style="color:' + st.fg + ';background:' + st.bg +
        ';border-color:' + st.bg + '">' + opts + '</select>' +
        '<button class="bt-btn bt-del" data-act="del-job" data-id="' + esc(j.id) +
        '" title="移除这个岗位，之后不再采集">×</button>' +
        '</div>');
    });
    return h.join('');
  }

  /* ---- 企业 ---- */
  function viewCompanies(state, jobs) {
    const groups = groupByCompany(state, jobs);
    const h = [];
    h.push('<div class="bt-card"><h2>添加关注企业</h2>' +
      '<div style="display:flex;gap:8px;margin-top:4px">' +
      '<input type="text" id="bt-c-name" placeholder="公司全称或常用简称，例如：字节跳动" ' +
      'style="flex:1;border:1px solid #e2e2e2;border-radius:8px;padding:7px 10px;font-size:12.5px;font-family:inherit;outline:none">' +
      '<button class="bt-btn primary" data-act="add-company">添加</button></div>' +
      '<div class="bt-mini">名字可以只写关键部分（如「蚂蚁」「网易」），脚本用模糊匹配识别岗位归属。</div></div>');

    h.push('<div class="bt-card"><h2>已关注 ' + state.companies.length + ' 家</h2>');
    if (!state.companies.length) {
      h.push('<div class="bt-empty"><b>还没有关注任何企业</b>先添加几家公司，脚本才知道要帮你记哪些岗位</div>');
    } else {
      state.companies.forEach(function (c) {
        const g = groups.filter(function (x) {
          return normName(x.name) === normName(c.name) || (x.name || '').indexOf(c.name) !== -1;
        })[0];
        const n = g ? g.jobs.length : 0;
        const nw = g ? g.jobs.filter(function (j) { return daysAgo(j.firstSeen) <= NEW_DAYS; }).length : 0;
        h.push('<div class="bt-row"><div class="tit"><b>' + esc(c.name) +
          (nw ? ' <span class="bt-chip" style="background:#FAEEDA;color:#854F0B">NEW ' + nw + '</span>' : '') +
          '</b><small>' + (g ? '最近更新 ' + fmtDate(g.lastSeen) : '还没采集到岗位') +
          ((c.aliases && c.aliases.length) ? ' · 别名：' + esc(c.aliases.join('、')) : '') +
          '</small></div>' +
          '<div class="bt-chip" style="background:#F1EFE8;color:#5F5E5A">' + n + ' 个</div>' +
          '<button class="bt-btn" data-act="alias-company" data-id="' + esc(c.id) + '">别名</button>' +
          '<button class="bt-btn danger" data-act="del-company" data-id="' + esc(c.id) + '">删除</button></div>');
      });
    }
    h.push('</div>');

    const untracked = groups.filter(function (g) {
      return !matchCompany(g.name, state);
    });
    if (untracked.length) {
      h.push('<div class="bt-card"><h2>采集到的其他公司（未关注）</h2>');
      untracked.slice(0, 12).forEach(function (g) {
        h.push('<div class="bt-row"><div class="tit"><b>' + esc(g.name) + '</b><small>' +
          g.jobs.length + ' 个岗位</small></div>' +
          '<button class="bt-btn" data-act="watch-company" data-name="' + esc(g.name) + '">加入关注</button></div>');
      });
      h.push('</div>');
    }
    return h.join('');
  }

  /* ---- 设置 ---- */
  function viewSettings(state, jobs) {
    const kws = (state.settings.keywords || []).map(function (k) {
      return '<span data-act="del-kw" data-kw="' + esc(k) + '">' + esc(k) + '</span>';
    }).join('');
    const hiddenCount = Object.keys(state.jobs).filter(function (k) {
      return state.jobs[k].hidden;
    }).length;

    return [
      '<div class="bt-card"><h2>关键词（命中即标星）</h2>',
      '<div class="bt-kw">' + (kws || '<span style="background:none;color:#aaa;padding:0">还没有关键词</span>') + '</div>',
      '<div style="display:flex;gap:8px;margin-top:10px">',
      '<input type="text" id="bt-kw-new" placeholder="输入关键词后回车，例如 HRBP" ',
      'style="flex:1;border:1px solid #e2e2e2;border-radius:8px;padding:7px 10px;font-size:12.5px;font-family:inherit;outline:none">',
      '<button class="bt-btn" data-act="add-kw">添加</button></div>',
      '<div class="bt-mini">点关键词可以删除。</div></div>',

      '<div class="bt-card"><h2>采集行为</h2>',
      '<label class="bt-toggle"><input type="checkbox" id="bt-opt-tracked"' +
      (state.settings.onlyTracked ? ' checked' : '') + '> 只记录关注企业的岗位</label>',
      '<label class="bt-toggle"><input type="checkbox" id="bt-opt-auto"' +
      (state.settings.autoCollect ? ' checked' : '') + '> 在 BOSS 页面自动采集</label>',
      '<div class="bt-mini">关掉「只记录关注企业」会把页面上所有岗位都收进来，数据会很快膨胀，一般不推荐。</div></div>',

      '<div class="bt-card"><h2>数据</h2>',
      '<div style="display:flex;gap:8px;flex-wrap:wrap">',
      '<button class="bt-btn" data-act="export-json">导出 JSON 备份</button>',
      '<button class="bt-btn" data-act="export-csv">导出 CSV（Excel 可看）</button>',
      '<button class="bt-btn" data-act="import-json">导入 JSON</button>',
      '<button class="bt-btn" data-act="rescan">立即重新采集当前页</button>',
      (hiddenCount ? '<button class="bt-btn" data-act="restore-hidden">恢复已移除的 ' + hiddenCount + ' 个岗位</button>' : ''),
      '<button class="bt-btn danger" data-act="clear">清空所有数据</button>',
      '</div>',
      '<div class="bt-mini">数据保存在油猴脚本的本地存储里，换电脑前记得导出备份。</div>',
      '<div class="bt-bar-line"></div>',
      '<div class="bt-mini">当前共 ' + jobs.length + ' 个岗位 / ' + state.companies.length + ' 家关注企业。' +
      '脚本只在你自己浏览器里运行，不会向任何服务器发送数据。</div></div>',

      '<div class="bt-card"><h2>没采集到岗位？</h2>',
      '<div class="bt-mini" style="line-height:1.9">',
      '1. 先确认「企业」页里有你正在看的这家公司（名字要能对上）。<br>',
      '2. 在搜索结果页或公司职位页停留 2 秒，脚本会自动扫描。<br>',
      '3. 如果还是空的，点上面「立即重新采集当前页」看提示。<br>',
      '4. BOSS 改版会导致识别失败，到时候告诉我，我修选择器。',
      '</div></div>'
    ].join('');
  }

  /* ---- 事件 ---- */
  function onBodyChange(e) {
    const t = e.target;
    const state = readState();
    if (t.id === 'bt-f-company') { ui.filter.company = t.value; render(); return; }
    if (t.id === 'bt-f-city') { ui.filter.city = t.value; render(); return; }
    if (t.id === 'bt-f-exp') { ui.filter.exp = t.value; render(); return; }
    if (t.id === 'bt-f-status') { ui.filter.status = t.value; render(); return; }
    if (t.id === 'bt-f-new') { ui.filter.onlyNew = t.checked; render(); return; }
    if (t.classList.contains('bt-status-sel')) {
      const id = t.getAttribute('data-id');
      if (state.jobs[id]) {
        state.jobs[id].status = t.value;
        state.jobs[id].statusAt = state.jobs[id].statusAt || {};
        state.jobs[id].statusAt[t.value] = Date.now();
        writeState(state);
        decorateCards();
        render();
      }
      return;
    }
    if (t.id === 'bt-opt-tracked') { state.settings.onlyTracked = t.checked; writeState(state); return; }
    if (t.id === 'bt-opt-auto') { state.settings.autoCollect = t.checked; writeState(state); return; }
  }

  function onBodyClick(e) {
    const el = e.target.closest('[data-act]');
    if (el) {
      const act = el.getAttribute('data-act');
      const state = readState();

      if (act === 'focus-new') {
        ui.tab = 'jobs';
        ui.filter.onlyNew = true;
        ui.root.querySelectorAll('.bt-tab').forEach(function (x) {
          x.classList.toggle('on', x.getAttribute('data-tab') === 'jobs');
        });
        render();
        return;
      }
      if (act === 'add-company') {
        const inp = document.getElementById('bt-c-name');
        const name = (inp && inp.value || '').trim();
        if (!name) return;
        if (state.companies.some(function (c) { return normName(c.name) === normName(name); })) {
          toast('已经在关注列表里了');
          return;
        }
        state.companies.push({ id: uid(), name: name, aliases: [], group: '', priority: 3 });
        writeState(state);
        render();
        toast('已添加：' + name);
        return;
      }
      if (act === 'del-company') {
        const id = el.getAttribute('data-id');
        state.companies = state.companies.filter(function (c) { return c.id !== id; });
        writeState(state);
        render();
        return;
      }
      if (act === 'del-job') {
        const id = el.getAttribute('data-id');
        if (state.jobs[id]) {
          state.jobs[id].hidden = true;
          state.jobs[id].hiddenAt = Date.now();
          writeState(state);
          decorateCards();
          render();
          toast('已移除，之后不会再采集');
        }
        return;
      }
      if (act === 'restore-hidden') {
        Object.keys(state.jobs).forEach(function (k) { delete state.jobs[k].hidden; });
        writeState(state);
        render();
        toast('已恢复全部移除的岗位');
        return;
      }
      if (act === 'alias-company') {
        const id = el.getAttribute('data-id');
        const c = state.companies.filter(function (x) { return x.id === id; })[0];
        if (!c) return;
        const input = prompt('给「' + c.name + '」加别名，多个用逗号分隔。\n用于匹配 BOSS 上写法不太一致的公司名。', (c.aliases || []).join(','));
        if (input == null) return;
        c.aliases = input.split(/[,，、]/).map(function (s) { return s.trim(); }).filter(Boolean);
        writeState(state);
        render();
        toast('别名已更新');
        return;
      }
      if (act === 'watch-company') {
        const name = el.getAttribute('data-name');
        state.companies.push({ id: uid(), name: name, aliases: [], group: '', priority: 3 });
        writeState(state);
        render();
        toast('已加入关注：' + name);
        return;
      }
      if (act === 'add-kw') {
        const inp = document.getElementById('bt-kw-new');
        const kw = (inp && inp.value || '').trim();
        if (!kw) return;
        state.settings.keywords = state.settings.keywords || [];
        if (state.settings.keywords.indexOf(kw) === -1) state.settings.keywords.push(kw);
        writeState(state);
        render();
        return;
      }
      if (act === 'del-kw') {
        const kw = el.getAttribute('data-kw');
        state.settings.keywords = (state.settings.keywords || []).filter(function (k) { return k !== kw; });
        writeState(state);
        render();
        return;
      }
      if (act === 'export-json') {
        download('boss-jobs-' + dateStr() + '.json', JSON.stringify(state, null, 2), 'application/json');
        return;
      }
      if (act === 'export-csv') {
        const rows = [['岗位', '公司', '城市', '薪资', '标签', '状态', '首次记录', '平台显示', '链接']];
        Object.keys(state.jobs).forEach(function (k) {
          const j = state.jobs[k];
          if (j.hidden) return;
          rows.push([j.title, j.company, j.area, j.salary, (j.tags || []).join('/'),
            (STATUS_MAP[j.status] || {}).label || j.status, fmtDate(j.firstSeen), j.platformTime, j.link]);
        });
        const csv = rows.map(function (r) {
          return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
        }).join('\r\n');
        download('boss-jobs-' + dateStr() + '.csv', '\ufeff' + csv, 'text/csv');
        return;
      }
      if (act === 'import-json') {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.json,application/json';
        inp.onchange = function () {
          const file = inp.files && inp.files[0];
          if (!file) return;
          const fr = new FileReader();
          fr.onload = function () {
            try {
              const data = normalize(JSON.parse(fr.result));
              const merged = readState();
              Object.keys(data.jobs).forEach(function (k) { if (!merged.jobs[k]) merged.jobs[k] = data.jobs[k]; });
              data.companies.forEach(function (c) {
                if (!merged.companies.some(function (x) { return normName(x.name) === normName(c.name); })) {
                  merged.companies.push(c);
                }
              });
              writeState(merged);
              render();
              toast('导入完成');
            } catch (err) { toast('导入失败：文件格式不对'); }
          };
          fr.readAsText(file);
        };
        inp.click();
        return;
      }
      if (act === 'rescan') {
        const r = scan();
        decorateCards();
        render();
        toast('扫描完成：识别 ' + r.total + ' 个，新增 ' + r.added + ' 个');
        return;
      }
      if (act === 'clear') {
        if (confirm('确定清空所有岗位和关注企业？这个操作不能撤销，建议先导出备份。')) {
          writeState(normalize(null));
          render();
          toast('已清空');
        }
        return;
      }
    }
  }

  function dateStr() {
    const d = new Date();
    const p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /* ==================== 悬浮球 ==================== */
  function buildOrb() {
    if (document.getElementById('bt-orb')) return;
    const orb = document.createElement('div');
    orb.id = 'bt-orb';
    orb.innerHTML = '追踪';
    orb.title = 'BOSS 岗位追踪台';
    orb.addEventListener('click', function () { openPanel(); });
    document.body.appendChild(orb);
    updateOrb();
  }

  function updateOrb() {
    const orb = document.getElementById('bt-orb');
    if (!orb) return;
    const state = readState();
    const jobs = Object.keys(state.jobs).map(function (k) { return state.jobs[k]; })
      .filter(function (j) { return !j.hidden; });
    const n = jobs.filter(function (j) { return daysAgo(j.firstSeen) <= NEW_DAYS; }).length;
    let badge = orb.querySelector('.bt-orb-badge');
    if (n > 0) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'bt-orb-badge';
        orb.appendChild(badge);
      }
      badge.textContent = n > 99 ? '99+' : n;
    } else if (badge) {
      badge.remove();
    }
  }

  /* ==================== 卡片装饰 ==================== */
  function decorateCards() {
    const state = readState();
    const anchors = document.querySelectorAll('a[href*="/job_detail"], a[href*="jobId="]');
    anchors.forEach(function (a) {
      const id = jobIdFromHref(a.getAttribute('href') || '');
      if (!id) return;
      const job = state.jobs[id];
      const card = a.closest('li') || a.closest('[class*="job-card"]');
      if (!card) return;
      const old = card.querySelector('.bt-chip[data-bt]');
      if (!job || job.hidden) {
        if (old) old.remove();
        card.classList.remove('bt-new');
        return;
      }
      const st = STATUS_MAP[job.status] || STATUS_LIST[0];
      const chipHtml = '<span class="bt-chip" data-bt="1" data-st="' + job.status +
        '" style="margin-left:8px;background:' + st.bg + ';color:' + st.fg + '">' + st.label + '</span>';
      if (old) {
        if (old.getAttribute('data-st') !== job.status) old.outerHTML = chipHtml;
      } else {
        const host = card.querySelector('[class*="job-card-footer"], [class*="card-footer"]') || card;
        host.insertAdjacentHTML('beforeend', chipHtml);
      }
      if (daysAgo(job.firstSeen) <= NEW_DAYS) card.classList.add('bt-new');
      else card.classList.remove('bt-new');
    });
  }

  /* ==================== 启动 ==================== */
  let scanTimer = null;
  let lastScanAt = 0;

  function scheduleScan(delay) {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      if (Date.now() - lastScanAt < 3000) return;
      lastScanAt = Date.now();
      const r = scan();
      if (r && !r.skipped) decorateCards();
    }, delay || 1500);
  }

  function boot() {
    injectStyle();
    buildOrb();
    scheduleScan(1200);

    const obs = new MutationObserver(function () {
      if (!document.getElementById('bt-orb')) buildOrb();
      scheduleScan(2000);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    ['pushState', 'replaceState'].forEach(function (fn) {
      const orig = history[fn];
      history[fn] = function () {
        const ret = orig.apply(this, arguments);
        scheduleScan(1500);
        return ret;
      };
    });
    window.addEventListener('popstate', function () { scheduleScan(1500); });

    window.__bossTracker = {
      scan: scan,
      decorate: decorateCards,
      state: readState,
      cityOf: cityOf,
      expKeyOf: expKeyOf,
      reset: function () { writeState(normalize(null)); location.reload(); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
