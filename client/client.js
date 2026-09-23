window.__ModuleLoader__.load({
  id: 'dsh-session-toolkit',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // dsh-dev 整合包 client 半：5 个功能模块内联（IIFE 隔离变量），统一 apply 顺序注册
    var registered = {};
    function collect(tag, applyFn) { registered[tag] = applyFn; }
    // 设置通道（DSH 0.1.7 起）：用户数据（身份文本、全局/工作区提示词、自动上线开关、UI 旋钮）
    // 是本插件条目 config 的 volatile 字段，浏览器半经 `ctx.configForms.get('session-toolkit')`
    // 读写——configForms 由 web 组合的 ui-settings 客户端半提供，写入落盘在当前 profile 的
    // cordis.patch.yml（不再是 settings.yaml 的命名空间，也没有 settingsScope 服务）。
    // 表单不可用（服务缺席/不兼容内核）时，各模块用这份兜底值保持行为不变。
    // 【提醒】新增旋钮必须同步两处：lib/index.js 的 Config.client、本 UI_FALLBACK。
    var ENTRY_ID = 'session-toolkit';
    var SETTINGS_SERVICE = 'configForms';
    var STATE_URL = '/api/session-toolkit/state';
    var UI_FALLBACK = {
      identityCharLimit: 4000,
      restartTimeoutMs: 90000,
      restartPollMs: 1000,
      restartFillMs: 600,
      restartFailThreshold: 2,
      restartSettleMs: 8000,
      copyFeedbackMs: 1600,
    };
    var uiCfg = Object.assign({}, UI_FALLBACK);

    // 本插件的配置表单（configForms 服务缺席/条目无 volatile 字段时返回 null）。
    function configForm(ctx) {
      var forms = ctx.get(SETTINGS_SERVICE);
      if (!forms || typeof forms.get !== 'function') return null;
      try { return forms.get(ENTRY_ID); } catch (e) { return null; }
    }

    // 把表单里的一段子对象适配成旧 scope 形状（getSnapshot/subscribe/set/unset/mutate），
    // 使各功能模块的读写代码保持不变：
    //   getSnapshot().value = 该子对象（config.<basePath...>）；set(key, v) 写 basePath + key。
    function sectionOf(form, basePath) {
      if (!form) return null;
      function sub(value) {
        var cur = value;
        for (var i = 0; i < basePath.length; i++) {
          if (!cur || typeof cur !== 'object') return undefined;
          cur = cur[basePath[i]];
        }
        return cur;
      }
      function pathOf(op) {
        return { op: op.op, path: basePath.concat(op.path), value: op.value };
      }
      return {
        getSnapshot: function () {
          var snap = form.getSnapshot();
          return {
            status: snap ? snap.status : 'unavailable',
            value: snap ? sub(snap.value) : undefined,
            revision: snap ? snap.revision : undefined,
            writable: snap ? snap.writable : false,
            mode: snap ? snap.mode : undefined,
          };
        },
        subscribe: function (listener) { return form.subscribe(listener); },
        set: function (key, value) { return form.mutate([{ op: 'set', path: basePath.concat([key]), value: value }]); },
        unset: function (key) { return form.mutate([{ op: 'unset', path: basePath.concat([key]) }]); },
        mutate: function (ops, revision) { return form.mutate(ops.map(pathOf), revision); },
      };
    }

    // 只读运行时投影（活跃工作区 + 引用文件读取状态）：host 经 GET STATE_URL 提供
    // （见 lib/global-prompt.js 的 STATE_ROUTE），浏览器按订阅数轮询，无人订阅即停。
    // 这两项是 host 运行时状态而非用户配置，故不走 settings 表单。
    var stateStore = (function () {
      var POLL_MS = 2000;
      var snapshot = { status: 'loading', value: { active: [], fileStatus: { byScope: {} } } };
      var listeners = [];
      var cancelTimer = null;
      var inFlight = false;
      function emit() {
        var list = listeners.slice();
        for (var i = 0; i < list.length; i++) {
          try { list[i](); } catch (e) { console.warn('[dsh-session-toolkit] state listener failed', e); }
        }
      }
      function refresh() {
        if (inFlight || typeof fetch !== 'function') return Promise.resolve();
        inFlight = true;
        return fetch(STATE_URL, { method: 'GET', cache: 'no-store' }).then(function (res) {
          if (!res || !res.ok) throw new Error('state route returned ' + (res ? res.status : 'no response'));
          return res.json();
        }).then(function (body) {
          snapshot = {
            status: 'ready',
            value: {
              active: body && Array.isArray(body.active) ? body.active : [],
              fileStatus: (body && body.fileStatus && typeof body.fileStatus === 'object') ? body.fileStatus : { byScope: {} },
            },
          };
        }).catch(function (e) {
          // 路由不可用（host 半未加载 / 非 web 承载）：停止轮询，UI 保持空列表与「未读取」状态
          if (snapshot.status === 'loading') snapshot = { status: 'unavailable', value: snapshot.value };
          console.warn('[dsh-session-toolkit] state route unavailable: ' + (e && e.message ? e.message : String(e)));
        }).then(function () {
          inFlight = false;
          emit();
        });
      }
      function poll(ctx) {
        cancelTimer = ctx.timeout(function () {
          cancelTimer = null;
          refresh().then(function () { if (listeners.length > 0) poll(ctx); });
        }, POLL_MS);
      }
      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function (ctx, listener) {
          listeners.push(listener);
          if (listeners.length === 1 && typeof ctx.timeout === 'function') {
            refresh().then(function () { if (listeners.length > 0) poll(ctx); });
          }
          return function () {
            var idx = listeners.indexOf(listener);
            if (idx === -1) return;
            listeners.splice(idx, 1);
            if (listeners.length === 0 && cancelTimer) { cancelTimer(); cancelTimer = null; }
          };
        },
      };
    })();

    // 运行时投影的两个只读读面，形状对齐被替换掉的 settings 命名空间（value.active / value.byScope）。
    function runtimeScope(ctx, field) {
      return {
        getSnapshot: function () {
          var snap = stateStore.getSnapshot();
          return {
            status: snap.status,
            value: field === 'fileStatus' ? { byScope: snap.value.fileStatus.byScope } : { active: snap.value.active },
          };
        },
        subscribe: function (listener) { return stateStore.subscribe(ctx, listener); },
      };
    }

    // UI 旋钮来自本条目 config 的 client.* 字段（表单快照）；缺失时保持兜底值。
    function readUiCfg(form) {
      if (!form) return;
      var snap = form.getSnapshot();
      var root = (snap && snap.value && typeof snap.value === 'object') ? snap.value : null;
      var v = (root && root.client && typeof root.client === 'object') ? root.client : null;
      if (!v) return;
      Object.keys(UI_FALLBACK).forEach(function (key) {
        if (typeof v[key] === 'number' && isFinite(v[key]) && v[key] > 0) uiCfg[key] = v[key];
      });
    }

    // ===== 模块 1：会话身份（identity，含自动上线开关行、header/input 双入口）=====
    (function () {
  var module = { exports: {} };
  var exports = module.exports;
  var React = require('react');

  var NS = 'session-identity-ui';
  // 字符上限来自 session-toolkit-ui 命名空间（见 factory 顶部的 uiCfg）：每次渲染时读取，
  // 设置值变化后下一次渲染即生效（此前是 apply 时一次性捕获，配置改动永远不生效）。
  function charLimit() { return uiCfg.identityCharLimit; }
  function charWarnAt() { return Math.floor(uiCfg.identityCharLimit * 0.8); }

  var zh = {
    nav: '会话身份',
    title: '会话身份',
    titleDefault: '默认身份',
    desc: '为本会话设置一段身份设定，注入该会话的系统提示词，作用于每一次模型调用。',
    descDefault: '默认身份作为新会话与未自定义会话的初始值。',
    badgeCustomOn: '已自定义',
    badgeCustomOff: '本会话已禁用',
    badgeDefaultOn: '使用默认身份',
    badgeOff: '未启用',
    enableLabel: '为本会话启用身份',
    enableHint: '关闭后，本会话不注入任何身份（即使默认身份已启用）。',
    defaultEnableLabel: '为新会话启用默认身份',
    defaultEnableHint: '关闭后，未自定义的会话不注入身份。',
    contentLabel: '身份设定',
    placeholder: '输入身份设定，例如：你是一位资深需求分析师（BA）……',
    inheritDefault: '继承默认身份',
    inheritDefaultHint: '清除本会话的自定义设置，回落到默认身份。',
    editDefault: '编辑默认身份',
    backToSession: '返回会话身份',
    save: '保存',
    autoSaved: '已自动保存',
    saving: '保存中…',
    savedToast: '已保存',
    savedInheritToast: '已恢复默认身份',
    saveError: '保存失败',
    overLimitMsg: '超出 4000 字符上限',
    loading: '加载中…',
    unavailable: '设置服务不可用',
    reset: '重置',
    unsaved: '未保存',
    close: '关闭',
    autoResumeLabel: '重启后自动上线',
    autoResumeHint: '开启后，每次重启 GUI 该会话自动恢复在线；关闭不影响当前状态，仅影响下次重启。',
    autoResumeError: '保存失败，请重试',
  };

  var en = {
    nav: 'Session Identity',
    title: 'Session Identity',
    titleDefault: 'Default Identity',
    desc: 'Set an identity prompt for this session: injected into this session\'s system prompt on every model call.',
    descDefault: 'The default identity seeds new sessions and sessions without their own identity.',
    badgeCustomOn: 'Custom',
    badgeCustomOff: 'Disabled here',
    badgeDefaultOn: 'Using default',
    badgeOff: 'Off',
    enableLabel: 'Enable identity for this session',
    enableHint: 'When off, no identity is injected into this session (even if the default is on).',
    defaultEnableLabel: 'Enable default identity for new sessions',
    defaultEnableHint: 'When off, sessions without their own identity get none.',
    contentLabel: 'Identity prompt',
    placeholder: 'e.g. You are a senior requirements analyst (BA)…',
    inheritDefault: 'Use default identity',
    inheritDefaultHint: 'Clear this session\'s custom settings and fall back to the default.',
    editDefault: 'Edit default identity',
    backToSession: 'Back to session identity',
    save: 'Save',
    autoSaved: 'Auto-saved',
    saving: 'Saving…',
    savedToast: 'Saved',
    savedInheritToast: 'Restored to default',
    saveError: 'Failed to save',
    overLimitMsg: 'Exceeds the 4000-char limit',
    loading: 'Loading…',
    unavailable: 'Settings service unavailable',
    reset: 'Reset',
    unsaved: 'Unsaved',
    close: 'Close',
    autoResumeLabel: 'Auto-resume after restart',
    autoResumeHint: 'When on, this session resumes online automatically after each GUI restart; turning off does not affect the current state, only the next restart.',
    autoResumeError: 'Failed to save, please retry',
  };

  function UserIcon() {
    return React.createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' }),
      React.createElement('circle', { cx: 12, cy: 7, r: 4 }));
  }

  function CloseIcon() {
    return React.createElement('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('line', { x1: 18, y1: 6, x2: 6, y2: 18 }),
      React.createElement('line', { x1: 6, y1: 6, x2: 18, y2: 18 }));
  }

  function BackIcon() {
    return React.createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('polyline', { points: '15 18 9 12 15 6' }));
  }

  function CheckIcon() {
    return React.createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('polyline', { points: '20 6 9 17 4 12' }));
  }

  function AlertIcon() {
    return React.createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }),
      React.createElement('line', { x1: 12, y1: 9, x2: 12, y2: 13 }),
      React.createElement('line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }));
  }


  // 模块级浮层互斥：同一会话双入口（header/input.left）与跨会话共用一份"打开"状态，
  // 任一入口打开时其他入口同步关闭，避免多个浮层叠加、独立编辑态相互覆盖。
  var floatingState = { sessionId: null, owner: null };
  var floatingSubscribers = [];

  function emitFloating() {
    floatingSubscribers.forEach(function (fn) { fn(); });
  }

  function openFloating(sessionId, owner) {
    if (floatingState.sessionId === sessionId && floatingState.owner === owner) return;
    floatingState.sessionId = sessionId;
    floatingState.owner = owner;
    emitFloating();
  }

  function closeFloating() {
    if (floatingState.sessionId === null) return;
    floatingState.sessionId = null;
    floatingState.owner = null;
    emitFloating();
  }

  function useFloating(sessionId, owner) {
    var state = React.useState(floatingState.sessionId === sessionId && floatingState.owner === owner);
    var setOpen = state[1];
    React.useEffect(function () {
      function listener() {
        setOpen(floatingState.sessionId === sessionId && floatingState.owner === owner);
      }
      floatingSubscribers.push(listener);
      // 会话切换（props.sessionId 变化但组件实例复用）时立即按新值重算，
      // 避免开着浮层切会话后浮层残留打开（floatingState 仍指向旧会话）。
      setOpen(floatingState.sessionId === sessionId && floatingState.owner === owner);
      return function () {
        var i = floatingSubscribers.indexOf(listener);
        if (i >= 0) floatingSubscribers.splice(i, 1);
      };
    }, [sessionId, owner]);
    return state;
  }

  function valueOf(snap) {
    return (snap && snap.value && typeof snap.value === 'object') ? snap.value : {};
  }

  // 解析某会话当前生效的身份（镜像 host 侧解析逻辑）
  function effectiveOf(snap, sessionId) {
    var v = valueOf(snap);
    var rec = v.sessions && typeof v.sessions === 'object' ? v.sessions[sessionId] : undefined;
    if (rec && typeof rec === 'object') {
      return {
        customized: true,
        enabled: rec.enabled === true,
        text: typeof rec.text === 'string' ? rec.text : '',
      };
    }
    var d = v.default && typeof v.default === 'object' ? v.default : {};
    return {
      customized: false,
      enabled: d.enabled === true,
      text: typeof d.text === 'string' ? d.text : '',
    };
  }

  function defaultOf(snap) {
    var v = valueOf(snap);
    var d = v.default && typeof v.default === 'object' ? v.default : {};
    return {
      enabled: d.enabled === true,
      text: typeof d.text === 'string' ? d.text : '',
    };
  }

  // 会话级「重启后自动上线」开关行：读写 dsh-auto-resume 的 session-auto-resume 命名空间。
  // 仅在身份浮层的会话模式显示；namespace 不可用时由调用方传入 null 不渲染。
  function AutoResumeRow(props) {
    var t = props.t;
    var scope = props.scope;
    var sessionId = props.sessionId;
    var ctx = props.ctx;
    var snap = scope.getSnapshot();
    var v = (snap && snap.value && typeof snap.value === 'object') ? snap.value : {};
    var sessions = v.sessions && typeof v.sessions === 'object' ? v.sessions : {};
    var onState = React.useState(sessions[sessionId] === true);
    var on = onState[0], setOn = onState[1];
    var savingState = React.useState(false);
    var saving = savingState[0], setSaving = savingState[1];
    var errState = React.useState(null);
    var err = errState[0], setErr = errState[1];

    React.useEffect(function () {
      return scope.subscribe(function () {
        var s2 = scope.getSnapshot();
        var v2 = (s2.value && typeof s2.value === 'object') ? s2.value : {};
        var ss = v2.sessions && typeof v2.sessions === 'object' ? v2.sessions : {};
        setOn(ss[sessionId] === true);
      });
      // sessionId 进依赖：会话切换但组件实例被复用时（slot 渲染器会复用实例，
      // 见 useFloating 的注释），旧闭包会把别的会话状态写进来。
    }, [sessionId]);

    // 容错：namespace 未就绪/不可用 → 渲染 null（hooks 已固定，安全）
    if (!snap || snap.status === 'loading' || snap.status === 'unavailable') return null;

    function toggle() {
      if (saving) return; // P3-2：保存中禁用，防连点
      var prev = on;
      var next = !prev;
      setSaving(true);
      var s2 = scope.getSnapshot();
      var v2 = (s2.value && typeof s2.value === 'object') ? s2.value : {};
      var ss = v2.sessions && typeof v2.sessions === 'object' ? Object.assign({}, v2.sessions) : {};
      if (next) ss[sessionId] = true; else delete ss[sessionId];
      Promise.resolve(scope.set('sessions', ss)).then(function () {
        // 读回校验（沿用身份保存模式）
        var s3 = scope.getSnapshot();
        var v3 = (s3.value && typeof s3.value === 'object') ? s3.value : {};
        var ss3 = v3.sessions && typeof v3.sessions === 'object' ? v3.sessions : {};
        var ok = next ? ss3[sessionId] === true : ss3[sessionId] === undefined;
        if (ok) {
          setOn(next);
        } else {
          // P3-1：冲突/失败回滚开关并给出可见反馈
          setOn(prev);
          setErr(t('autoResumeError'));
          ctx.timeout(function () { setErr(null); }, 2000);
        }
      }).catch(function () {
        setOn(prev);
        setErr(t('autoResumeError'));
        ctx.timeout(function () { setErr(null); }, 2000);
      }).then(function () {
        setSaving(false);
      });
    }

    return React.createElement('div', null,
      React.createElement('div', { className: 'si-auto-resume' },
        React.createElement('button', { type: 'button', role: 'switch', 'aria-checked': on, className: 'si-switch' + (on ? ' on' : ''), disabled: saving, onClick: toggle, 'aria-label': t('autoResumeLabel') },
          React.createElement('span', { className: 'si-switch-thumb' })),
        React.createElement('div', { className: 'si-enable-text' },
          React.createElement('div', { className: 'si-enable-label' }, t('autoResumeLabel')),
          React.createElement('div', { className: 'si-enable-hint' }, t('autoResumeHint')))),
      err ? React.createElement('div', { className: 'si-auto-resume-error', role: 'status' }, err) : null);
  }


  function IdentityButton(props) {
    var t = props.t;
    var scope = props.scope;
    var sessionId = props.sessionId;
    var owner = props.owner;
    var autoResumeScope = props.autoResumeScope;
    var floating = useFloating(sessionId, owner);
    var open = floating[0];

    // dot 状态订阅：settings 变更时刷新按钮状态点（不依赖 slot 重渲染）
    var forceState = React.useState(0);
    React.useEffect(function () {
      return scope.subscribe(function () { forceState[1](function (x) { return x + 1; }); });
    }, []);

    var snap = scope.getSnapshot();
    var eff = effectiveOf(snap, sessionId);

    var dotClass = 'si-dot ' + (eff.enabled ? (eff.customized ? 'custom' : 'default') : 'off');

    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        type: 'button',
        onClick: function () { openFloating(sessionId, owner); },
        title: t('nav'),
        'aria-label': t('nav'),
        className: 'si-trigger',
      },
        React.createElement(UserIcon, null),
        React.createElement('span', { className: dotClass, 'aria-hidden': true })),
      open ? React.createElement(IdentityDialog, {
        t: t, scope: scope, sessionId: sessionId, ctx: props.ctx,
        autoResumeScope: autoResumeScope,
        onClose: closeFloating,
      }) : null);
  }

  function IdentityDialog(props) {
    var t = props.t;
    var scope = props.scope;
    var sessionId = props.sessionId;
    var ctx = props.ctx;
    var onClose = props.onClose;
    var autoResumeScope = props.autoResumeScope;

    var modeState = React.useState('session');
    var mode = modeState[0], setMode = modeState[1];
    var snap = scope.getSnapshot();
    var eff = effectiveOf(snap, sessionId);
    var dflt = defaultOf(snap);

    var enabledState = React.useState(eff.enabled);
    var enabled = enabledState[0], setEnabled = enabledState[1];
    var textState = React.useState(eff.text);
    var text = textState[0], setText = textState[1];
    var savingState = React.useState(false);
    var saving = savingState[0], setSaving = savingState[1];
    var toastState = React.useState(null);
    var toast = toastState[0], setToast = toastState[1];

    var lastSavedRef = React.useRef({ enabled: eff.enabled, text: eff.text.trim() });
    // 开关即时保存的防重入 guard：避免快速连点触发并发写（读-改-写窗口）
    var persistBusyRef = React.useRef(false);

    React.useEffect(function () {
      return scope.subscribe(function () {
        var s = scope.getSnapshot();
        var e = effectiveOf(s, sessionId);
        var prevSaved = lastSavedRef.current;
        lastSavedRef.current = { enabled: e.enabled, text: e.text.trim() };
        // 编辑态未被用户改动（== 上次已保存值）时同步外部变更；否则保留输入
        setEnabled(function (prev) { return prev === prevSaved.enabled ? e.enabled : prev; });
        setText(function (prev) { return prev === prevSaved.text ? e.text : prev; });
      });
    }, [sessionId]);

    React.useEffect(function () {
      if (!toast) return;
      return ctx.timeout(function () { setToast(null); }, 2000);
    }, [toast]);

    function onKeyDown(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (mode === 'default') saveDefault(); else save();
      }
    }

    function save() {
      if (saving) return;
      if (overLimit) { setToast({ type: 'err', text: t('saveError') + ': ' + t('overLimitMsg') }); return; }
      if (!sessionId) { setToast({ type: 'err', text: t('saveError') + ': 会话未就绪' }); return; }
      setSaving(true);
      var next = { enabled: enabled, text: text.trim() };
      var s = scope.getSnapshot();
      var v = valueOf(s);
      var sessions = v.sessions && typeof v.sessions === 'object' ? Object.assign({}, v.sessions) : {};
      var d = v.default && typeof v.default === 'object' ? v.default : {};
      var dText = typeof d.text === 'string' ? d.text.trim() : '';
      var promise;
      // 与默认解析值一致 → 删除本会话记录（保持"继承默认"语义）；否则写记录
      if (next.enabled === (d.enabled === true) && next.text === dText) {
        if (Object.prototype.hasOwnProperty.call(sessions, sessionId)) {
          delete sessions[sessionId];
          promise = Promise.resolve(scope.set('sessions', sessions));
        } else {
          promise = Promise.resolve();
        }
      } else {
        sessions[sessionId] = { enabled: next.enabled, text: next.text };
        promise = Promise.resolve(scope.set('sessions', sessions));
      }
      promise.then(function () {
        // 校验写入是否真正生效：框架 set 失败路径可能静默 resolve（revision 冲突被吞），
        // 并发保存（读-改-写窗口）也可能丢记录。读回快照核对，不一致报冲突。
        var s2 = scope.getSnapshot();
        var v2 = valueOf(s2);
        var cur = v2.sessions && typeof v2.sessions === 'object' ? v2.sessions[sessionId] : undefined;
        var d2 = v2.default && typeof v2.default === 'object' ? v2.default : {};
        var d2Text = typeof d2.text === 'string' ? d2.text.trim() : '';
        // 注（P2-3 边界）：matchesDefault 用保存后的默认值 d2 判断，而写入/删除分支在保存前
        // 用保存前默认值 d 决策。若保存期间默认身份恰好被外部改为与本次输入一致，可能把
        // "已写入的记录"判为"应删除"→ 误报保存冲突（数据实际已成功）。极低概率、方向保守，可接受。
        var matchesDefault = next.enabled === (d2.enabled === true) && next.text === d2Text;
        var ok = matchesDefault
          ? cur === undefined
          : cur !== undefined && cur.enabled === next.enabled && (typeof cur.text === 'string' ? cur.text.trim() : '') === next.text;
        if (ok) {
          lastSavedRef.current = next;
          setToast({ type: 'ok', text: t('savedToast') });
        } else {
          setToast({ type: 'err', text: t('saveError') + ': 保存冲突，请重试' });
        }
      }).catch(function (e) {
        setToast({ type: 'err', text: t('saveError') + ((e && e.message) ? ': ' + e.message : '') });
      }).then(function () {
        setSaving(false);
      });
    }

    function saveDefault() {
      if (saving) return;
      if (overLimit) { setToast({ type: 'err', text: t('saveError') + ': ' + t('overLimitMsg') }); return; }
      setSaving(true);
      var next = { enabled: enabled, text: text.trim() };
      Promise.resolve(scope.set('default', next)).then(function () {
        var s2 = scope.getSnapshot();
        var d2 = defaultOf(s2);
        var ok = d2.enabled === next.enabled && (typeof d2.text === 'string' ? d2.text.trim() : '') === next.text;
        if (ok) {
          lastSavedRef.current = next;
          setToast({ type: 'ok', text: t('savedToast') });
        } else {
          setToast({ type: 'err', text: t('saveError') + ': 保存冲突，请重试' });
        }
      }).catch(function (e) {
        setToast({ type: 'err', text: t('saveError') + ((e && e.message) ? ': ' + e.message : '') });
      }).then(function () {
        setSaving(false);
      });
    }

    // 开关即时保存：写完整快照（enabled + 当前 text），与默认解析值一致则删记录（保持"继承默认"语义）
    function persistIdentity(nextEnabled) {
      if (persistBusyRef.current) return;
      persistBusyRef.current = true;
      var nextText = text.trim();
      var s = scope.getSnapshot();
      var v = valueOf(s);
      var promise;
      if (mode === 'default') {
        promise = Promise.resolve(scope.set('default', { enabled: nextEnabled, text: nextText }));
      } else {
        var sessions = v.sessions && typeof v.sessions === 'object' ? Object.assign({}, v.sessions) : {};
        var d = v.default && typeof v.default === 'object' ? v.default : {};
        var dText = typeof d.text === 'string' ? d.text.trim() : '';
        if (nextEnabled === (d.enabled === true) && nextText === dText) {
          if (Object.prototype.hasOwnProperty.call(sessions, sessionId)) {
            delete sessions[sessionId];
            promise = Promise.resolve(scope.set('sessions', sessions));
          } else {
            promise = Promise.resolve();
          }
        } else {
          sessions[sessionId] = { enabled: nextEnabled, text: nextText };
          promise = Promise.resolve(scope.set('sessions', sessions));
        }
      }
      promise.then(function () {
        // 读回校验（与 save 一致，防框架静默 resolve / 并发丢记录）
        var s2 = scope.getSnapshot();
        var v2 = valueOf(s2);
        var ok;
        if (mode === 'default') {
          var d2 = defaultOf(s2);
          ok = d2.enabled === nextEnabled && (typeof d2.text === 'string' ? d2.text.trim() : '') === nextText;
        } else {
          var cur = v2.sessions && typeof v2.sessions === 'object' ? v2.sessions[sessionId] : undefined;
          var d2b = v2.default && typeof v2.default === 'object' ? v2.default : {};
          var d2bText = typeof d2b.text === 'string' ? d2b.text.trim() : '';
          var matchesDefault = nextEnabled === (d2b.enabled === true) && nextText === d2bText;
          ok = matchesDefault
            ? cur === undefined
            : cur !== undefined && cur.enabled === nextEnabled && (typeof cur.text === 'string' ? cur.text.trim() : '') === nextText;
        }
        if (ok) {
          lastSavedRef.current = { enabled: nextEnabled, text: nextText };
          setEnabled(nextEnabled);
          setToast({ type: 'ok', text: t('savedToast') });
        } else {
          setToast({ type: 'err', text: t('saveError') + ': 保存冲突，请重试' });
        }
      }).catch(function (e) {
        setToast({ type: 'err', text: t('saveError') + ((e && e.message) ? ': ' + e.message : '') });
      }).then(function () {
        persistBusyRef.current = false;
      });
    }

    function inheritDefault() {
      if (saving) return;
      setSaving(true);
      var s = scope.getSnapshot();
      var v = valueOf(s);
      var sessions = v.sessions && typeof v.sessions === 'object' ? Object.assign({}, v.sessions) : {};
      if (Object.prototype.hasOwnProperty.call(sessions, sessionId)) delete sessions[sessionId];
      Promise.resolve(scope.set('sessions', sessions)).then(function () {
        var s2 = scope.getSnapshot();
        var v2 = valueOf(s2);
        var cur = v2.sessions && typeof v2.sessions === 'object' ? v2.sessions[sessionId] : undefined;
        if (cur === undefined) {
          setEnabled(dflt.enabled);
          setText(dflt.text);
          lastSavedRef.current = { enabled: dflt.enabled, text: dflt.text.trim() };
          setToast({ type: 'ok', text: t('savedInheritToast') });
        } else {
          setToast({ type: 'err', text: t('saveError') + ': 保存冲突，请重试' });
        }
      }).catch(function (e) {
        setToast({ type: 'err', text: t('saveError') + ((e && e.message) ? ': ' + e.message : '') });
      }).then(function () {
        setSaving(false);
      });
    }

    if (scope.getSnapshot().status === 'loading') {
      return React.createElement(SiFrame, { onClose: onClose, onKeyDown: onKeyDown, t: t },
        React.createElement('div', { className: 'si-busy' }, t('loading')));
    }
    if (scope.getSnapshot().status === 'unavailable') {
      return React.createElement(SiFrame, { onClose: onClose, onKeyDown: onKeyDown, t: t },
        React.createElement('div', { className: 'si-busy si-busy-err' }, t('unavailable')));
    }

    var count = text.length;
    var countClass = 'si-count' + (count > charLimit() ? ' si-count-error' : (count > charWarnAt() ? ' si-count-warn' : ''));
    var dirty = enabled !== lastSavedRef.current.enabled || text.trim() !== lastSavedRef.current.text;
    var overLimit = count > charLimit();

    if (mode === 'default') {
      return React.createElement(SiFrame, { onClose: onClose, onKeyDown: onKeyDown, t: t },
        React.createElement('div', { className: 'si-head' },
          React.createElement('div', { className: 'si-title-row' },
            React.createElement('button', { type: 'button', className: 'si-back', onClick: function () { setMode('session'); setEnabled(dflt.enabled); setText(dflt.text); lastSavedRef.current = { enabled: dflt.enabled, text: dflt.text.trim() }; }, 'aria-label': t('backToSession') },
              React.createElement(BackIcon, null)),
            React.createElement('div', { className: 'si-title-group' },
              React.createElement(UserIcon, null),
              React.createElement('h1', { className: 'si-title' }, t('titleDefault'))),
            React.createElement('button', { type: 'button', className: 'si-close', onClick: onClose, 'aria-label': t('close') },
              React.createElement(CloseIcon, null))),
          React.createElement('p', { className: 'si-desc' }, t('descDefault'))),
        React.createElement('div', { className: 'si-enable' },
          React.createElement('button', { type: 'button', role: 'switch', 'aria-checked': enabled, className: 'si-switch' + (enabled ? ' on' : ''), onClick: function () { persistIdentity(!enabled); }, 'aria-label': t('defaultEnableLabel') },
            React.createElement('span', { className: 'si-switch-thumb' })),
          React.createElement('div', { className: 'si-enable-text' },
            React.createElement('div', { className: 'si-enable-label' }, t('defaultEnableLabel')),
            React.createElement('div', { className: 'si-enable-hint' }, t('defaultEnableHint')))),
        React.createElement('div', { className: 'si-content' + (enabled ? '' : ' si-disabled') },
          React.createElement('div', { className: 'si-label-row' },
            React.createElement('label', { className: 'si-label', htmlFor: 'si-area-default' }, t('contentLabel')),
            React.createElement('span', { className: countClass }, String(count) + ' 字符')),
          React.createElement('textarea', { id: 'si-area-default', className: 'si-area', value: text, disabled: !enabled, spellCheck: false, placeholder: t('placeholder'), onChange: function (e) { setText(e.target.value); } })),
        React.createElement('div', { className: 'si-actions' },
          dirty ? React.createElement('span', { className: 'si-unsaved', role: 'status' }, t('unsaved')) : null,
          React.createElement('button', { type: 'button', className: 'si-btn si-reset', onClick: function () { setEnabled(dflt.enabled); setText(dflt.text); } }, t('reset')),
          React.createElement('button', { type: 'button', className: 'si-btn si-save', disabled: saving || !dirty || overLimit, onClick: saveDefault },
            saving ? React.createElement(React.Fragment, null,
              React.createElement('span', { className: 'si-spinner', 'aria-hidden': true }), t('saving')) : t('save'))),
        toast ? React.createElement(SiToast, { toast: toast }) : null);
    }

    var badgeClass = 'si-badge ' + (eff.enabled ? (eff.customized ? 'custom' : 'default') : 'off');
    var badgeText = eff.enabled ? (eff.customized ? t('badgeCustomOn') : t('badgeDefaultOn')) : (eff.customized ? t('badgeCustomOff') : t('badgeOff'));

    return React.createElement(SiFrame, { onClose: onClose, onKeyDown: onKeyDown, t: t },
      React.createElement('div', { className: 'si-head' },
        React.createElement('div', { className: 'si-title-row' },
          React.createElement('div', { className: 'si-title-group' },
            React.createElement(UserIcon, null),
            React.createElement('h1', { className: 'si-title' }, t('title'))),
          React.createElement('span', { className: badgeClass }, badgeText)),
        React.createElement('p', { className: 'si-desc' }, t('desc'))),
      React.createElement('div', { className: 'si-enable' },
        React.createElement('button', { type: 'button', role: 'switch', 'aria-checked': enabled, className: 'si-switch' + (enabled ? ' on' : ''), onClick: function () { persistIdentity(!enabled); }, 'aria-label': t('enableLabel') },
          React.createElement('span', { className: 'si-switch-thumb' })),
        React.createElement('div', { className: 'si-enable-text' },
          React.createElement('div', { className: 'si-enable-label' }, t('enableLabel')),
          React.createElement('div', { className: 'si-enable-hint' }, t('enableHint')))),
      React.createElement('div', { className: 'si-content' + (enabled ? '' : ' si-disabled') },
        React.createElement('div', { className: 'si-label-row' },
          React.createElement('label', { className: 'si-label', htmlFor: 'si-area' }, t('contentLabel')),
          React.createElement('span', { className: countClass }, String(count) + ' 字符')),
        React.createElement('textarea', { id: 'si-area', className: 'si-area', value: text, disabled: !enabled, spellCheck: false, placeholder: t('placeholder'), onChange: function (e) { setText(e.target.value); } })),
      React.createElement('div', { className: 'si-inherit' },
        React.createElement('button', { type: 'button', className: 'si-link', disabled: saving || !eff.customized, onClick: inheritDefault },
          t('inheritDefault')),
        React.createElement('span', { className: 'si-inherit-hint' }, t('inheritDefaultHint'))),
      autoResumeScope ? React.createElement(AutoResumeRow, {
        t: t, scope: autoResumeScope, sessionId: sessionId, ctx: ctx,
      }) : null,
      React.createElement('div', { className: 'si-actions-between' },
        React.createElement('button', { type: 'button', className: 'si-link', disabled: saving, onClick: function () { setMode('default'); setEnabled(dflt.enabled); setText(dflt.text); lastSavedRef.current = { enabled: dflt.enabled, text: dflt.text.trim() }; } },
          t('editDefault')),
        React.createElement('div', { className: 'si-actions' },
          dirty ? React.createElement('span', { className: 'si-unsaved', role: 'status' }, t('unsaved')) : null,
          React.createElement('button', { type: 'button', className: 'si-btn si-reset', onClick: function () { setEnabled(lastSavedRef.current.enabled); setText(lastSavedRef.current.text); } }, t('reset')),
          React.createElement('button', { type: 'button', className: 'si-btn si-save', disabled: saving || !dirty || overLimit, onClick: save },
            saving ? React.createElement(React.Fragment, null,
              React.createElement('span', { className: 'si-spinner', 'aria-hidden': true }), t('saving')) : t('save')))),
      toast ? React.createElement(SiToast, { toast: toast }) : null);
  }

  // ===== 浮层拖动（裁定 #12 / #13）=====
  // 手柄是标题行 .si-title-row：卡片内还有 textarea 与若干按钮，整卡拖动会与文本选择、
  // 按钮点击冲突。位移用 transform: translate，不动 .si-mask 的 flex 布局（遮罩是全屏的，
  // 且它可能被其它地方复用）。位置是一过性 UI 状态，随浮层关闭复位，不持久化。
  // ⚠️ .si-mask 的垂直位置由 `padding:9vh 24px 24px` + `align-items:flex-start` 共同决定，
  // 改这两个值就会改变卡片的初始 rect，也就是本段钳制算式的输入基准——改动前先看这里。
  //
  // 钳制的基准问题：rect 读取时已经含当前 translate，直接相加会重复计算。本实现对「静止」
  // 和「拖动中」用同一套算式——因为 k = 本次 rect − 本次已应用的 d 等于布局位置（translate
  // 不改变布局位置，这一点由 offsetLeft/offsetTop 恒定为 0 独立印证），故对本次 rect 做钳制
  // 等于对布局位置做钳制。拖动会话期间 rect 是冻结的，因此在会话内也能用同一算式直接钳制。
  //
  // 单轴区间（裁定 #13 的核心）：对一条轴，令
  //   lo = -rect.left                     「贴住起始边」所需的平移量
  //   hi = vw - rect.right                「贴住终止边」所需的平移量
  // 装得下时 lo <= 0 <= hi ⇒ 区间取 [lo, hi]：卡片完全在视口内，两端都够得到。
  //
  // 装不下（max-height:100vh + overflow:auto，缩窗后出现）时 hi < lo：左右两个「贴边」要求
  // 不可能同时满足，此时**不能任取其一**——
  //   · 只取 lo ⇒ 终止边永远够不到（#12 的缺陷：双维溢出下底部 361px 永久不可达）；
  //   · 只取 hi ⇒ 起始边够不到。
  // 退役化为「起始边始终可见（lo 兜底），终止边则必须能拖到 vw 处」：
  //   d ∈ [min(lo, hi), max(lo, hi)]  ⇒  可达像素 = |hi - lo| = 卡片尺寸 - 视口尺寸（同轴）
  // 注意低端是 **min(lo, hi)** 而非 lo：hi < lo 时取值区间要覆盖两端（hi 是较大的那个负数），
  // 写成 `[lo, max(lo, hi)]` 会退化成 [lo, lo]（这正是本裁定第一版补丁的错误）。
  // 副作用：卡片比视口大时它可以被拖出视口一部分——这是「够得到另一端」的必要代价，
  // 且起始边永远 ≥ 0，卡片不会被推出视口、拖不回来。
  function siClampAxis(lo, hi, v) {
    return v < lo ? lo : (v > hi ? hi : v);
  }
  function siClamp(dx, dy, rect) {
    if (!rect) return { dx: dx, dy: dy };
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    // 装不下时区间取 [min, max]：起始边可见由 min 兜住，终止边可达由 max 兜住。
    if (rect.left + rect.width > vw) {
      var hlo = -rect.left;
      var hhi = -(rect.left + rect.width - vw);
      dx = siClampAxis(Math.min(hlo, hhi), Math.max(hlo, hhi), dx);
    } else {
      dx = siClampAxis(-rect.left, vw - rect.right, dx);
    }
    if (rect.top + rect.height > vh) {
      var vlo = -rect.top;
      var vhi = -(rect.top + rect.height - vh);
      dy = siClampAxis(Math.min(vlo, vhi), Math.max(vlo, vhi), dy);
    } else {
      dy = siClampAxis(-rect.top, vh - rect.bottom, dy);
    }
    return { dx: dx, dy: dy };
  }

  // siClamp(dx, dy, rect) 的两个入参**各有契约**（裁定 #17 修正）：
  //   · rect 必须是**布局矩形**——getBoundingClientRect() 返回的是「布局位置 + 当前 translate」，
  //     必须先减去当前已应用的平移才是布局矩形；
  //   · dx/dy 必须是**相对布局位置的绝对平移量**，不是「本次按下以来的位移」。
  // 违反任一条的后果：钳制出的区间整体平移了「当前平移量」，于是每次新会话都从布局位置重新开始
  // ——用户看到的就是「第二次一按下就跳回原位」。第一次拖动恰好看不出问题（起始 pos=0、位移==绝对平移）。
  // ⚠️ 更正一条曾写在这里的**错误推理**（它正是这个 bug 的来源）：
  //   旧注释说「k = 本次 rect − 本次已应用的 d 等于布局位置，故对本次 rect 做钳制等于对布局位置做钳制」。
  //   这句**不等价**：用含 translate 的 rect 去钳，允许区间会整体平移 d_cur（实测 200 → 0）。
  //   正确的做法是本函数做的显式减法，不是"两边同时平移所以等价"。
  function siLayoutRect(card, dx, dy) {
    var r = card.getBoundingClientRect();
    return {
      left: r.left - dx, top: r.top - dy, right: r.right - dx, bottom: r.bottom - dy,
      width: r.width, height: r.height,
    };
  }

  // 标题行内可能有按钮。若用户按在按钮上并发生了拖动，松手时浏览器会补一次 click，
  // 那不是「点击」而是拖动残留。以拖动距离（>4px）判定并吞掉那一次 click——
  // 未移动就松手 ⇒ 不拦截，按钮行为完全不变（AC50）。
  function siSwallowNextClick() {
    var swallow = function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      remove();
    };
    var remove = function () {
      document.removeEventListener('click', swallow, true);
      window.clearTimeout(timer);
    };
    var timer = window.setTimeout(remove, 400);
    document.addEventListener('click', swallow, true);
  }

  function SiFrame(props) {
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var cardRef = useRef(null);
    // rectForClamp：静止时 = 布局矩形（每次渲染重新量），拖动会话期间 = 会话开始时冻结的矩形。
    var posRef = useRef({ dx: 0, dy: 0, rectForClamp: null });
    var sessionRef = useRef(null);
    var posState = useState({ dx: 0, dy: 0 });
    var pos = posState[0];
    var setPos = posState[1];
    var dragState = useState(false);
    var dragging = dragState[0];
    var setDragging = dragState[1];

    useEffect(function () {
      return function () {
        // 卸载（浮层关闭）时必须摘掉挂在 window 上的监听，否则会泄漏到下一次打开。
        var ses = sessionRef.current;
        if (ses) {
          window.removeEventListener('mousemove', ses.onMove, true);
          window.removeEventListener('mouseup', ses.onUp, true);
          sessionRef.current = null;
        }
      };
    }, []);

    // 静止时把**布局矩形**写进 posRef，供 resize 钳制使用；拖动会话期间不覆盖（会话已冻结自己的基准）。
    // 注意：getBoundingClientRect 含当前 translate，必须减去当前平移才是布局矩形（裁定 #17）。
    if (!dragging) {
      var cardEl = cardRef.current;
      if (cardEl) posRef.current.rectForClamp = siLayoutRect(cardEl, pos.dx, pos.dy);
      posRef.current.dx = pos.dx;
      posRef.current.dy = pos.dy;
    }

    // 缩窗后必须重新钳制，否则卡片可能落到视口外、再也拖不回来。
    useEffect(function () {
      var onResize = function () {
        var rect = posRef.current.rectForClamp;
        if (!rect) return;
        var c = siClamp(posRef.current.dx, posRef.current.dy, rect);
        if (c.dx === posRef.current.dx && c.dy === posRef.current.dy) return;
        posRef.current.dx = c.dx;
        posRef.current.dy = c.dy;
        setPos({ dx: c.dx, dy: c.dy });
      };
      window.addEventListener('resize', onResize);
      return function () { window.removeEventListener('resize', onResize); };
    }, []);

    function onTitleMouseDown(e) {
      if (e.button !== 0) return;
      // 手柄内的按钮/链接不参与拖动（它们的 click 照旧）。
      var el = e.target;
      while (el && el !== e.currentTarget) {
        var tag = el.tagName;
        if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        el = el.parentNode;
      }
      var card = cardRef.current;
      if (!card) return;
      // 会话内冻结基准（裁定 #17）：本次拖动是「从当前位置继续」，
      // 故后续位移一律以 base + 本次鼠标位移 的**绝对平移量**喂 siClamp，
      // 并用**布局矩形**（量到的 rect 减去 base）作为钳制基准。
      var baseDx = posRef.current.dx;
      var baseDy = posRef.current.dy;
      var rect = siLayoutRect(card, baseDx, baseDy);
      var startX = e.clientX;
      var startY = e.clientY;
      var moved = false;
      var ses = {
        onMove: function (ev) {
          var rawX = baseDx + (ev.clientX - startX);
          var rawY = baseDy + (ev.clientY - startY);
          if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) moved = true;
          var c = siClamp(rawX, rawY, rect);
          if (c.dx === posRef.current.dx && c.dy === posRef.current.dy) return;
          posRef.current.dx = c.dx;
          posRef.current.dy = c.dy;
          posRef.current.rectForClamp = rect;
          setPos({ dx: c.dx, dy: c.dy });
          // 阻止拖动期间的文本选择与图片/链接拖拽。
          ev.preventDefault();
        },
        onUp: function (ev) {
          window.removeEventListener('mousemove', ses.onMove, true);
          window.removeEventListener('mouseup', ses.onUp, true);
          sessionRef.current = null;
          setDragging(false);
          if (moved) siSwallowNextClick();
          ev.preventDefault();
        },
      };
      sessionRef.current = ses;
      setDragging(true);
      window.addEventListener('mousemove', ses.onMove, true);
      window.addEventListener('mouseup', ses.onUp, true);
      // 从手柄起手即禁选，避免「按下—微动」就开始划词。
      e.preventDefault();
    }

    // 手柄注入（裁定 #16）：在**整棵子树**里找 .si-title-row 并注入，而不是只看顶层孩子。
    // 此前只看顶层孩子 ⇒ 顶层是 .si-head、标题行嵌在它里面 ⇒ 一次都没匹配到 ⇒ 拖动从未生效。
    // 递归的理由：调用点的孩子嵌套深度是「渲染实现细节」，子树与绝对深度的耦合比递归更脆；
    // 且 SiFrame 的孩子是 React 元素（不是 DOM 树），遍历代价可忽略（浮层每次打开渲染一次）。
    // 前提：.si-title-row 目前只有 CSS 类、无内联 style，故这里 set style 不会冲掉既有内联样式；
    // 若将来给它加了内联 style，必须改为与 child.props.style 合并（{ ...child.props.style, ...handleStyle }）。
    var handleStyle = { cursor: dragging ? 'grabbing' : 'grab' };
    var titleRows = 0;
    var withHandle = function (node) {
      if (!React.isValidElement(node)) return node;
      if (node.props.className === 'si-title-row') {
        titleRows++;
        return React.cloneElement(node, { onMouseDown: onTitleMouseDown, style: handleStyle });
      }
      var kids = node.props.children;
      if (kids === undefined || kids === null) return node;
      if (Array.isArray(kids)) {
        var mapped = [];
        var changed = false;
        for (var i = 0; i < kids.length; i++) {
          var next = withHandle(kids[i]);
          if (next !== kids[i]) changed = true;
          mapped.push(next);
        }
        return changed ? React.cloneElement(node, { children: mapped }) : node;
      }
      var nextKid = withHandle(kids);
      return nextKid === kids ? node : React.cloneElement(node, { children: nextKid });
    };
    var framed = withHandle(React.createElement(React.Fragment, null, props.children));
    // 作用点自检（A 裁定 #16② 收窄后的条件）：**树里有标题行、但注入一个都没命中**才出声。
    // 此前写的是 titleRows === 0 ⇒ 会在 loading / unavailable 这两个完全正常的态上响假警报，
    // 而控制台是唯一的诊断面——"可被合理驳回的红会训练人忽略红"。
    // ⚠️ 这个计数**必须独立于 withHandle**（那条路数的是"注入命中数"，用它自己数"树里有几个"
    //    等于用输出证明输出）。故下面另走一遍纯遍历，只数节点、不注入。
    var treeTitleRows = 0;
    var countTitleRows = function (node) {
      if (!React.isValidElement(node)) return;
      if (node.props.className === 'si-title-row') { treeTitleRows++; return; }
      var kids = node.props.children;
      if (kids === undefined || kids === null) return;
      if (Array.isArray(kids)) {
        for (var i = 0; i < kids.length; i++) countTitleRows(kids[i]);
        return;
      }
      countTitleRows(kids);
    };
    countTitleRows(React.createElement(React.Fragment, null, props.children));
    if (treeTitleRows > 0 && titleRows === 0 && typeof console !== 'undefined' && console.warn) {
      console.warn('[dsh-session-identity] SiFrame: the overlay tree contains a title row, but the drag handle was not attached to it (dragging will not work).');
    }

    return React.createElement('div', {
      className: 'si-mask',
      style: dragging ? { userSelect: 'none' } : null,
      onMouseDown: function (e) {
        // 拖动会话期间不因遮罩点击而关闭（拖动从手柄起手本来就不命中 e.currentTarget，
        // 这里是兜底：万一指针事件在遮罩上重新落点）。
        if (sessionRef.current) return;
        if (e.target === e.currentTarget) props.onClose();
      },
    },
      React.createElement('div', {
        ref: cardRef,
        className: 'si-card',
        tabIndex: -1,
        onKeyDown: props.onKeyDown,
        role: 'dialog',
        'aria-modal': true,
        style: { transform: 'translate(' + pos.dx + 'px, ' + pos.dy + 'px)' },
      }, framed));
  }

  function SiToast(props) {
    var toast = props.toast;
    return React.createElement('div', { className: 'si-toast ' + (toast.type === 'ok' ? 'ok' : 'err'), role: 'status' },
      toast.type === 'ok' ? React.createElement(CheckIcon, null) : React.createElement(AlertIcon, null),
      React.createElement('span', null, toast.text));
  }

  function apply(ctx, cfg) {
    // cfg 即 uiCfg（client.* 表单快照 / 兜底默认值），字符上限在使用处读取。
    injectCss();
    var locale = ctx.get('locale');
    var slots = ctx.get('slots');
    var form = configForm(ctx);
    if (!slots || !form) return;

    var t = function (key) { return zh[key] || key; };
    if (locale) {
      ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }); }, 'dsh-session-identity: locale');
      t = locale.bind(NS);
    }

    var scope = sectionOf(form, ['identity']);
    // 自动上线开关：本条目 config 的 autoResume.sessions（host 半 dsh-auto-resume 读写同一份）
    var autoResumeScope = sectionOf(form, ['autoResume']);
    slots.inject('conversation.session.header.actions', function () {
      return slots.register({
        name: 'conversation.session.header.actions',
        id: 'session-identity',
        order: 40,
        label: function () { return t('nav'); },
        locale: NS,
      }, function (props) {
        return React.createElement(IdentityButton, {
          sessionId: props.sessionId,
          owner: 'header',
          scope: scope,
          ctx: ctx,
          t: t,
          autoResumeScope: autoResumeScope,
        });
      });
    });

    // 工具行入口（方案 A：空白会话可见性，与 header.actions 并存）
    slots.inject('conversation.input.left', function () {
      return slots.register({
        name: 'conversation.input.left',
        id: 'session-identity-input',
        order: 40,
        label: function () { return t('nav'); },
        locale: NS,
      }, function (props) {
        return React.createElement(IdentityButton, {
          sessionId: props.sessionId,
          owner: 'input',
          scope: scope,
          ctx: ctx,
          t: t,
          autoResumeScope: autoResumeScope,
        });
      });
    });
  }

  function injectCss() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('dsh-session-identity-css')) return;
    var style = document.createElement('style');
    style.id = 'dsh-session-identity-css';
    style.setAttribute('data-plugin', 'dsh-session-identity');
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  var CSS = [
    '.si-mask{position:fixed;inset:0;z-index:14000;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:flex-start;justify-content:center;padding:9vh 24px 24px;box-sizing:border-box;font-family:var(--dsw-font-family)}',
    '.si-card{width:680px;max-width:100%;max-height:100vh;overflow:auto;display:flex;flex-direction:column;gap:18px;background:var(--dsw-alias-bg-layer-1);border:0;border-radius:12px;box-shadow:var(--dsw-elevation-panel);padding:24px 28px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6;animation:si-in .18s ease;outline:none}',
    '.si-card>*{flex-shrink:0}',
    '.si-head{display:flex;flex-direction:column;gap:6px}',
    '.si-title-row{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:grab;user-select:none}',
    '.si-title-group{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-primary)}',
    '.si-title{margin:0;font-size:18px;font-weight:600;line-height:1.3}',
    '.si-back,.si-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s ease,color .15s ease}',
    '.si-back:hover,.si-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
    '.si-desc{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
    '.si-badge{flex:none;height:24px;line-height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}',
    '.si-badge.custom{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
    '.si-badge.default{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}',
    '.si-badge.off{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
    '.si-enable{display:flex;align-items:flex-start;gap:12px}',
    '.si-switch{position:relative;flex:none;width:40px;height:22px;margin-top:2px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .2s ease;box-sizing:border-box}',
    '.si-switch.on{background:var(--dsw-alias-state-business-primary)}',
    '.si-switch-thumb{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);box-shadow:0 1px 2px rgba(0,0,0,.15);transition:transform .2s ease}',
    '.si-switch.on .si-switch-thumb{transform:translateX(18px)}',
    '.si-enable-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.si-enable-label{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}',
    '.si-enable-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}',
    '.si-content{display:flex;flex-direction:column;gap:10px;transition:opacity .2s ease}',
    '.si-content.si-disabled{opacity:.45;pointer-events:none}',
    '.si-label-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
    '.si-label{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}',
    '.si-count{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
    '.si-count-warn{color:var(--dsw-alias-state-warn-primary)}',
    '.si-count-error{color:var(--dsw-alias-state-error-primary)}',
    '.si-area{width:100%;min-height:480px;padding:12px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-family:inherit;font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary);resize:vertical;transition:border-color .2s ease,box-shadow .2s ease}',
    '.si-area::placeholder{color:var(--dsw-alias-label-secondary)}',
    '.si-area:focus{outline:none;border-color:var(--dsw-alias-border-l2);box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover-accent)}',
    '.si-inherit{display:flex;align-items:center;gap:8px}',
    '.si-inherit-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}',
    '.si-auto-resume{display:flex;align-items:flex-start;gap:12px}',
    '.si-auto-resume-error{font-size:12px;color:var(--dsw-alias-state-error-primary);margin-top:4px}',
    '.si-link{display:inline-flex;align-items:center;padding:4px 8px;border:none;border-radius:8px;background:transparent;font-family:inherit;font-size:13px;font-weight:500;color:var(--dsw-alias-state-business-primary);cursor:pointer;text-align:left;transition:background .15s ease,color .15s ease}',
    '.si-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}',
    '.si-link:disabled{color:var(--dsw-alias-label-secondary);cursor:not-allowed;background:transparent}',
    '.si-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px}',
    '.si-actions-between{display:flex;align-items:center;justify-content:space-between;gap:12px}',
    '.si-unsaved{font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
    '.si-btn{height:36px;padding:0 20px;border-radius:999px;border:1px solid transparent;font-family:inherit;font-size:14px;font-weight:500;cursor:pointer;transition:background .2s ease,color .2s ease,border-color .2s ease,transform .1s ease}',
    '.si-reset{background:transparent;color:var(--dsw-alias-label-secondary)}',
    '.si-reset:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
    '.si-reset:active{transform:translateY(1px)}',
    '.si-save{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
    '.si-save:hover:not(:disabled){background:var(--dsw-static-deepseek-400)}',
    '.si-save:active:not(:disabled){transform:translateY(1px)}',
    '.si-save:disabled{cursor:not-allowed;opacity:.45}',
    '.si-spinner{display:inline-block;width:14px;height:14px;margin-right:6px;vertical-align:-2px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:si-spin .6s linear infinite}',
    '.si-btn:focus-visible,.si-switch:focus-visible,.si-link:focus-visible,.si-back:focus-visible,.si-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
    '.si-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;position:relative;transition:color .15s ease}',
    '.si-trigger:hover{color:var(--dsw-alias-label-primary)}',
    '.si-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:15000;display:flex;align-items:center;gap:8px;padding:10px 20px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:14px;animation:si-in .18s ease}',
    '.si-toast.ok{color:var(--dsw-alias-state-success-primary)}',
    '.si-toast.err{color:var(--dsw-alias-state-error-primary)}',
    '.si-busy{padding:48px 24px;text-align:center;color:var(--dsw-alias-label-secondary)}',
    '.si-busy-err{color:var(--dsw-alias-state-error-primary)}',
    '.si-dot{position:absolute;right:2px;bottom:2px;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--dsw-alias-bg-layer-1);box-sizing:border-box}',
    '.si-dot.custom{background:var(--dsw-alias-state-success-primary)}',
    '.si-dot.default{background:var(--dsw-alias-state-business-primary)}',
    '.si-dot.off{background:var(--dsw-alias-label-secondary)}',
    '@keyframes si-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}',
    '@keyframes si-spin{to{transform:rotate(360deg)}}',
    '',
  ].join('\n');

  var name = 'dsh-session-identity';
  var inject = ['slots', 'locale', 'configForms', 'timer'];
collect('identity', apply);
  exports.name = name;
    })();

    // ===== 模块 2：全局提示词设置页（global-prompt，settings.section）=====
    (function () {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
  var React = require('react');
  var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

  var NS = 'global-prompt-ui';

  var zh = {
    nav: '全局提示词',
    title: '全局提示词',
    tabGlobal: '全局',
    tabWorkspace: '按工作区',
    desc: '为所有会话注入一段全局提示词，并为指定工作区注入专属提示词。',
    scopeOrder: '按 会话身份 → 全局 → 工作区 顺序拼接。',
    badgeOn: '已启用',
    badgeOff: '已关闭',
    enableLabel: '启用全局提示词',
    enableHint: '关闭后，提示词不会注入到任何会话。',
    workspaceEnableHint: '开启后，以该工作区为根目录的会话会注入此提示词。',
    contentLabel: '提示词内容',
    charUnit: '字符',
    filesLabel: '引用文件',
    addFile: '添加文件',
    filePlaceholder: '输入文件路径',
    readFail: '读取失败',
    readPending: '未读取',
    placeholder: '输入提示词内容，例如：始终使用简体中文回答……',
    save: '保存',
    autoSaved: '已自动保存',
    saving: '保存中…',
    savedToast: '已保存',
    saveError: '保存失败',
    conflict: '保存冲突，请重试',
    loading: '加载中…',
    unavailable: '设置服务不可用',
    reset: '重置',
    unsaved: '未保存',
    emptyWorkspaces: '暂无活跃工作区',
    emptyHint: '打开以某工作区为根目录的会话后，这里会自动列出并配置专属提示词。',
    removedHint: '已从自动列表移除；重新启用或保存即可恢复。',
    inactive: '未活跃',
    remove: '移除',
    sessionUnit: '个会话',
  };

  var en = {
    nav: 'Global Prompt',
    title: 'Global Prompt',
    tabGlobal: 'Global',
    tabWorkspace: 'Per workspace',
    desc: 'Inject a global prompt into every conversation and per-workspace prompts for specific workspaces.',
    scopeOrder: 'Assembled in order: session identity → global → workspace.',
    badgeOn: 'Enabled',
    badgeOff: 'Disabled',
    enableLabel: 'Enable global prompt',
    enableHint: 'When off, the prompt is not injected into any conversation.',
    workspaceEnableHint: 'When on, conversations rooted at this workspace get this prompt.',
    contentLabel: 'Prompt content',
    charUnit: 'chars',
    filesLabel: 'Referenced files',
    addFile: 'Add file',
    filePlaceholder: 'Enter file path',
    readFail: 'Read failed',
    readPending: 'Not read',
    placeholder: 'Enter prompt content, e.g. Always answer in English…',
    save: 'Save',
    autoSaved: 'Auto-saved',
    saving: 'Saving…',
    savedToast: 'Saved',
    saveError: 'Failed to save',
    conflict: 'Save conflict, retry',
    loading: 'Loading…',
    unavailable: 'Settings service unavailable',
    reset: 'Reset',
    unsaved: 'Unsaved',
    emptyWorkspaces: 'No active workspaces',
    emptyHint: 'Open a conversation rooted at a workspace and it will appear here for its own prompt.',
    removedHint: 'Removed from the auto list; re-enable or save to restore it.',
    inactive: 'Inactive',
    remove: 'Remove',
    sessionUnit: ' sessions',
  };

  // 字符上限来自 session-toolkit-ui（见 factory 顶部 uiCfg），渲染时读取。
  function charLimit() { return uiCfg.identityCharLimit; }
  function charWarnAt() { return Math.floor(uiCfg.identityCharLimit * 0.8); }

  function CheckIcon() {
    return React.createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('polyline', { points: '20 6 9 17 4 12' }));
  }

  function AlertIcon() {
    return React.createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }),
      React.createElement('line', { x1: 12, y1: 9, x2: 12, y2: 13 }),
      React.createElement('line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }));
  }

  function SwitchRow(props) {
    var t = props.t;
    var enabled = props.enabled;
    var onToggle = props.onToggle;
    var label = props.label;
    var hint = props.hint;
    return React.createElement('div', { className: 'dsw-enable' },
      React.createElement('button', { type: 'button', role: 'switch', 'aria-checked': enabled, className: 'dsw-switch' + (enabled ? ' on' : ''), onClick: onToggle, 'aria-label': label },
        React.createElement('span', { className: 'dsw-switch-thumb' })),
      React.createElement('div', { className: 'dsw-enable-text' },
        React.createElement('div', { className: 'dsw-enable-label' }, label),
        React.createElement('div', { className: 'dsw-enable-hint' }, hint)));
  }

  function Toast(props) {
    var toast = props.toast;
    var t = props.t;
    return React.createElement('div', { className: 'dsw-toast ' + (toast.type === 'ok' ? 'ok' : 'err'), role: 'status' },
      toast.type === 'ok' ? React.createElement(CheckIcon, null) : React.createElement(AlertIcon, null),
      React.createElement('span', null, toast.text));
  }

  function TabBar(props) {
    var t = props.t;
    var tab = props.tab;
    var onTab = props.onTab;
    return React.createElement('div', { className: 'dsw-tabs', role: 'tablist' },
      React.createElement('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'global', className: 'dsw-tab' + (tab === 'global' ? ' active' : ''), onClick: function () { onTab('global'); } }, t('tabGlobal')),
      React.createElement('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'workspace', className: 'dsw-tab' + (tab === 'workspace' ? ' active' : ''), onClick: function () { onTab('workspace'); } }, t('tabWorkspace')));
  }

  function WorkspaceRow(props) {
    var t = props.t;
    var path = props.path;
    var ctx = props.ctx;
    var wsScope = props.wsScope;
    var fsStatusScope = props.fsStatusScope;
    var active = props.active;
    var removed = props.removed === true;
    var sessionCount = props.sessionCount;
    var onRemove = props.onRemove;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var openState = useState(false);
    var open = openState[0], setOpen = openState[1];

    var snap = wsScope.getSnapshot();
    var v0 = (snap && snap.value && typeof snap.value === 'object') ? snap.value : {};
    var ws0 = (v0.workspaces && typeof v0.workspaces === 'object') ? v0.workspaces : {};
    var rec0 = ws0[path] || {};
    var initEnabled = rec0.enabled === true;
    var initContent = typeof rec0.content === 'string' ? rec0.content : '';

    var enabledState = useState(initEnabled);
    var enabled = enabledState[0], setEnabled = enabledState[1];
    var contentState = useState(initContent);
    var content = contentState[0], setContent = contentState[1];
    var savingState = useState(false);
    var saving = savingState[0], setSaving = savingState[1];
    var toastState = useState(null);
    var toast = toastState[0], setToast = toastState[1];
    var lastSavedRef = useRef({ enabled: initEnabled, content: initContent });
    var initFiles = Array.isArray(rec0.files) ? rec0.files : [];
    var filesState = useState(initFiles);
    var files = filesState[0], setFiles = filesState[1];
    var wsSnap2 = fsStatusScope ? fsStatusScope.getSnapshot() : null;
    var wsVal2 = (wsSnap2 && wsSnap2.value && typeof wsSnap2.value === 'object') ? wsSnap2.value : {};
    var wsBy = (wsVal2.byScope && typeof wsVal2.byScope === 'object') ? wsVal2.byScope : {};
    var wsFileStatus = Array.isArray(wsBy[path]) ? wsBy[path] : [];
    function onWsFilesChange(newFiles) {
      setFiles(newFiles);
      var s = wsScope.getSnapshot();
      var v = (s && s.value && typeof s.value === 'object') ? s.value : {};
      var ws = (v.workspaces && typeof v.workspaces === 'object') ? { ...v.workspaces } : {};
      var rec = (ws[path] && typeof ws[path] === 'object') ? { ...ws[path] } : { enabled: false, content: '', files: [] };
      rec.files = newFiles;
      ws[path] = rec;
      Promise.resolve(wsScope.set('workspaces', ws)).catch(function (e) { console.warn('[dsh-global-prompt] workspace projection update failed', e); });
    }

    useEffect(function () {
      return wsScope.subscribe(function () {
        var s = wsScope.getSnapshot();
        var v = (s && s.value && typeof s.value === 'object') ? s.value : {};
        var ws = (v.workspaces && typeof v.workspaces === 'object') ? v.workspaces : {};
        var r = ws[path] || {};
        var e = r.enabled === true;
        var c = typeof r.content === 'string' ? r.content : '';
        // 只在「本地编辑态 == 上次已保存值」时同步外部变更；用户正在输入/切换时保留输入，
        // 否则 autosave 落地或另一行保存触发的快照刷新会把当前编辑回退掉。
        var prevSaved = lastSavedRef.current;
        lastSavedRef.current = { enabled: e, content: c };
        setEnabled(function (prev) { return prev === prevSaved.enabled ? e : prev; });
        setContent(function (prev) { return prev === prevSaved.content ? c : prev; });
      });
    }, [path]);

    // 用户此前点过「移除」的路径记在 workspace-prompt.removed 里；重新启用或保存 = 明确恢复，
    // 因此要把该路径从 removed 摘掉，否则下次工作区同步仍会把它当作「用户已移除」。
    function clearRemoved() {
      var s = wsScope.getSnapshot();
      var v = (s && s.value && typeof s.value === 'object') ? s.value : {};
      var rd = Array.isArray(v.removed) ? v.removed.slice() : [];
      var idx = rd.indexOf(path);
      if (idx === -1) return Promise.resolve();
      rd.splice(idx, 1);
      return Promise.resolve(wsScope.set('removed', rd));
    }

    useEffect(function () {
      if (!toast) return;
      return ctx.timeout(function () { setToast(null); }, 2000);
    }, [toast]);

    function save() {
      if (saving) return;
      setSaving(true);
      var s = wsScope.getSnapshot();
      var v = (s && s.value && typeof s.value === 'object') ? s.value : {};
      var ws = (v.workspaces && typeof v.workspaces === 'object') ? { ...v.workspaces } : {};
      var cur = (ws[path] && typeof ws[path] === 'object') ? { ...ws[path] } : { enabled: false, content: '', files: [] };
      var next = { enabled: cur.enabled, content: content, files: files };
      ws[path] = next;
      Promise.resolve(wsScope.set('workspaces', ws)).then(function () {
        return clearRemoved();
      }).then(function () {
        var s2 = wsScope.getSnapshot();
        var v2 = (s2 && s2.value && typeof s2.value === 'object') ? s2.value : {};
        var ws2 = (v2.workspaces && typeof v2.workspaces === 'object') ? v2.workspaces : {};
        var cur2 = ws2[path];
        var ok = cur2 && cur2.enabled === next.enabled && (typeof cur2.content === 'string' ? cur2.content : '') === next.content && Array.isArray(cur2.files) && JSON.stringify(cur2.files) === JSON.stringify(next.files);
        if (ok) {
          lastSavedRef.current = next;
          setToast({ type: 'ok', text: t('savedToast') });
        } else {
          setToast({ type: 'err', text: t('saveError') + ': ' + t('conflict') });
        }
      }).catch(function () {
        setToast({ type: 'err', text: t('saveError') });
      }).then(function () {
        setSaving(false);
      });
    }

    function saveWsEnabled(next) {
      var s = wsScope.getSnapshot();
      var v = (s && s.value && typeof s.value === 'object') ? s.value : {};
      var ws = (v.workspaces && typeof v.workspaces === 'object') ? { ...v.workspaces } : {};
      var rec = (ws[path] && typeof ws[path] === 'object') ? { ...ws[path] } : { enabled: false, content: '', files: [] };
      rec.enabled = next;
      ws[path] = rec;
      Promise.resolve(wsScope.set('workspaces', ws)).then(function () {
        if (next === true) return clearRemoved();
      }).then(function () {
        var s2 = wsScope.getSnapshot();
        var v2 = (s2 && s2.value && typeof s2.value === 'object') ? s2.value : {};
        var ws2 = (v2.workspaces && typeof v2.workspaces === 'object') ? v2.workspaces : {};
        var cur = ws2[path];
        if (cur && cur.enabled === next) {
          setEnabled(next);
          lastSavedRef.current = { enabled: next, content: lastSavedRef.current.content };
        } else {
          setToast({ type: 'err', text: t('saveError') + ': ' + t('conflict') });
        }
      }).catch(function () {
        setToast({ type: 'err', text: t('saveError') });
      });
    }

    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        save();
      }
    }

    var count = content.length;
    var countClass = 'dsw-count' + (count > charLimit() ? ' dsw-count-error' : (count > charWarnAt() ? ' dsw-count-warn' : ''));
    var disabled = !enabled;
    var dirty = enabled !== lastSavedRef.current.enabled || content !== lastSavedRef.current.content;
    var rowTitle = active ? path : (path + ' · ' + t('inactive'));
    var areaId = 'dsw-ws-' + path;

    return React.createElement(primitives.DisclosureRow, {
      icon: React.createElement(primitives.IconFolderOpenOutlineRegular, { size: 16 }),
      title: rowTitle,
      open: open,
      expandable: true,
      keepContentWhenOpen: true,
      collapsedContent: React.createElement('span', { className: 'dsw-ws-badge' }, String(sessionCount) + ' ' + t('sessionUnit')),
      onToggle: function () { setOpen(!open); },
      expandOnRowClick: true,
    },
      React.createElement('div', { className: 'dsw-ws-body', onKeyDown: onKeyDown },
        React.createElement(SwitchRow, {
          t: t,
          enabled: enabled,
          onToggle: function () { saveWsEnabled(!enabled); },
          label: t('enableLabel'),
          hint: t('workspaceEnableHint'),
        }),
        React.createElement('div', { className: 'dsw-content' + (disabled ? ' dsw-disabled' : '') },
          React.createElement('div', { className: 'dsw-label-row' },
            React.createElement('label', { className: 'dsw-label', htmlFor: areaId }, t('contentLabel')),
            React.createElement('span', { className: countClass }, String(count) + ' ' + t('charUnit'))),
          React.createElement('textarea', { id: areaId, className: 'dsw-area', value: content, disabled: disabled, spellCheck: false, placeholder: t('placeholder'), onChange: function (e) { setContent(e.target.value); } })),
        React.createElement(FileRefsPanel, { t: t, files: files, onFilesChange: onWsFilesChange, statuses: wsFileStatus }),
        removed ? React.createElement('div', { className: 'dsw-removed-hint' }, t('removedHint')) : null,
        React.createElement('div', { className: 'dsw-actions' },
          dirty ? React.createElement('span', { className: 'dsw-unsaved', role: 'status' }, t('unsaved')) : null,
          React.createElement(primitives.Button, { variant: 'ghost', size: 'sm', onClick: function () { onRemove(path); } }, t('remove')),
          React.createElement(primitives.Button, { variant: 'ghost', size: 'sm', onClick: function () { setEnabled(false); setContent(''); } }, t('reset')),
          React.createElement(primitives.Button, { variant: 'primary', size: 'sm', disabled: saving || disabled || !dirty, onClick: save }, saving ? t('saving') : t('save'))),
        toast ? React.createElement(Toast, { toast: toast, t: t }) : null));
  }

  function FileRefsPanel(props) {
    var t = props.t;
    var files = props.files;
    var onFilesChange = props.onFilesChange;
    var statuses = props.statuses;
    var addInput = React.useState('');
    var input = addInput[0], setInput = addInput[1];
    function add() {
      var val = input.trim();
      if (!val || files.indexOf(val) !== -1) { setInput(''); return; }
      onFilesChange(files.concat([val]));
      setInput('');
    }
    function remove(idx) {
      var next = files.slice();
      next.splice(idx, 1);
      onFilesChange(next);
    }
    return React.createElement('div', { className: 'dsw-files' },
      React.createElement('div', { className: 'dsw-files-label' }, t('filesLabel')),
      React.createElement('div', { className: 'dsw-files-list' }, (files || []).map(function (fp, idx) {
        var st = null;
        for (var i = 0; i < statuses.length; i++) { if (statuses[i].filePath === fp) { st = statuses[i]; break; } }
        return React.createElement('div', { key: String(idx), className: 'dsw-file-item' },
          React.createElement('span', { className: 'dsw-file-path' }, fp),
          React.createElement('span', { className: 'dsw-file-status ' + (st ? (st.status === 'ok' ? 'ok' : 'fail') : 'pending') },
            st ? (st.status === 'ok' ? (String(st.charCount) + ' ' + t('charUnit')) : (st.reason || t('readFail'))) : t('readPending')),
          React.createElement('button', { type: 'button', className: 'dsw-file-remove', onClick: function () { remove(idx); }, 'aria-label': t('remove') }, '\u00d7'));
      })),
      React.createElement('div', { className: 'dsw-files-add' },
        React.createElement('input', { className: 'dsw-file-input', value: input, placeholder: t('filePlaceholder'), onChange: function (e) { setInput(e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } } }),
        React.createElement(primitives.Button, { variant: 'ghost', size: 'sm', onClick: add }, t('addFile'))));
  }

  function GlobalPromptPage(props) {
    var t = props.t;
    var scope = props.scope;
    var wsScope = props.wsScope;
    var activeScope = props.activeScope;
    var fsStatusScope = props.fsStatusScope;
    var ctx = props.ctx;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var tabState = useState('global');
    var tab = tabState[0], setTab = tabState[1];

    var gSnap = scope.getSnapshot();
    var gInitial = (gSnap && gSnap.value && typeof gSnap.value === 'object') ? gSnap.value : {};
    var gEnabledState = useState(gInitial.enabled === true);
    var gEnabled = gEnabledState[0], setGEnabled = gEnabledState[1];
    var gContentState = useState(typeof gInitial.content === 'string' ? gInitial.content : '');
    var gContent = gContentState[0], setGContent = gContentState[1];
    var gSavingState = useState(false);
    var gSaving = gSavingState[0], setGSaving = gSavingState[1];
    var gToastState = useState(null);
    var gToast = gToastState[0], setGToast = gToastState[1];
    var gLastSavedRef = useRef({ enabled: gInitial.enabled === true, content: typeof gInitial.content === 'string' ? gInitial.content : '' });
    var gFilesState = useState(Array.isArray(gInitial.files) ? gInitial.files : []);
    var gFiles = gFilesState[0], setGFiles = gFilesState[1];
    // 活跃工作区与引用文件状态来自 host 只读路由的轮询（见 factory 顶部 stateStore）：
    // 订阅它，数据到达 / 刷新时才重渲染本页与各行。
    var stateTick = useState(0);
    useEffect(function () {
      var bump = function () { stateTick[1](function (x) { return x + 1; }); };
      var offActive = activeScope ? activeScope.subscribe(bump) : null;
      var offFiles = fsStatusScope ? fsStatusScope.subscribe(bump) : null;
      return function () {
        if (offActive) offActive();
        if (offFiles) offFiles();
      };
    }, []);
    var fileSnap = fsStatusScope ? fsStatusScope.getSnapshot() : null;
    var fileVal = (fileSnap && fileSnap.value && typeof fileSnap.value === 'object') ? fileSnap.value : {};
    var gFileStatus = (fileVal.byScope && Array.isArray(fileVal.byScope.global)) ? fileVal.byScope.global : [];
    function onFilesChange(newFiles) { setGFiles(newFiles); Promise.resolve(scope.set('files', newFiles)).catch(function (e) { console.warn('[dsh-global-prompt] files update failed', e); }); }
    var gAutoTimerRef = useRef(null);
    var autoSaveState = useState(null);
    var gAutoSave = autoSaveState[0], setGAutoSave = autoSaveState[1];

    function onChangeContent(e) {
      var val = e.target.value;
      setGContent(val);
      if (gAutoTimerRef.current) { gAutoTimerRef.current(); gAutoTimerRef.current = null; }
      setGAutoSave('saving');
      gAutoTimerRef.current = ctx.timeout(function () {
        gAutoTimerRef.current = null;
        Promise.resolve(scope.set('content', val)).then(function () {
          var s = scope.getSnapshot();
          var v = (s && s.value && typeof s.value === 'object') ? s.value : {};
          var saved = typeof v.content === 'string' && v.content === val;
          setGAutoSave(saved ? 'saved' : 'saving');
          gLastSavedRef.current = { enabled: gEnabled, content: val };
        }).catch(function () { setGAutoSave('saving'); });
      }, 500);
    }

    useEffect(function () {
      return function () {
        if (gAutoTimerRef.current) { gAutoTimerRef.current(); gAutoTimerRef.current = null; }
      };
    }, []);
    var gStatus = gSnap ? gSnap.status : 'loading';

    useEffect(function () {
      return scope.subscribe(function () {
        var s = scope.getSnapshot();
        var v = (s && s.value && typeof s.value === 'object') ? s.value : {};
        // 与身份模块同款保护：只有本地编辑态等于上次已保存值时才接受外部变更，
        // 否则 autosave 落地（或另一处写入）触发的快照刷新会回退正在输入的内容。
        var next = {
          enabled: v.enabled === true,
          content: typeof v.content === 'string' ? v.content : '',
        };
        var prevSaved = gLastSavedRef.current;
        gLastSavedRef.current = next;
        setGEnabled(function (prev) { return prev === prevSaved.enabled ? next.enabled : prev; });
        setGContent(function (prev) { return prev === prevSaved.content ? next.content : prev; });
      });
    }, []);

    useEffect(function () {
      if (!gToast) return;
      return ctx.timeout(function () { setGToast(null); }, 2000);
    }, [gToast]);

    function saveGlobal() {
      if (gSaving) return;
      setGSaving(true);
      var next = { enabled: gEnabled, content: gContent };
      Promise.resolve(scope.set('enabled', next.enabled)).then(function () {
        return scope.set('content', next.content);
      }).then(function () {
        gLastSavedRef.current = next;
        setGToast({ type: 'ok', text: t('savedToast') });
      }).catch(function (e) {
        setGToast({ type: 'err', text: t('saveError') + ((e && e.message) ? ': ' + e.message : '') });
      }).then(function () {
        setGSaving(false);
      });
    }

    function saveGlobalEnabled(next) {
      if (gSaving) return;
      setGSaving(true);
      Promise.resolve(scope.set('enabled', next)).then(function () {
        var s = scope.getSnapshot();
        var v = (s && s.value && typeof s.value === 'object') ? s.value : {};
        var ok = v.enabled === next;
        if (ok) {
          gLastSavedRef.current = { enabled: next, content: gLastSavedRef.current.content };
          setGEnabled(next);
          setGToast({ type: 'ok', text: t('savedToast') });
        } else {
          setGToast({ type: 'err', text: t('saveError') + ': ' + t('conflict') });
        }
      }).catch(function (e) {
        setGToast({ type: 'err', text: t('saveError') + ((e && e.message) ? ': ' + e.message : '') });
      }).then(function () {
        setGSaving(false);
      });
    }

    function onGlobalKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveGlobal();
      }
    }

    if (gStatus === 'loading') {
      return React.createElement('div', { className: 'dsw-page dsw-busy' }, t('loading'));
    }
    if (gStatus === 'unavailable') {
      return React.createElement('div', { className: 'dsw-page dsw-busy dsw-busy-err' }, t('unavailable'));
    }

    var gCount = gContent.length;
    var gCountClass = 'dsw-count' + (gCount > charLimit() ? ' dsw-count-error' : (gCount > charWarnAt() ? ' dsw-count-warn' : ''));
    var gDisabled = !gEnabled;
    var gDirty = gEnabled !== gLastSavedRef.current.enabled || gContent !== gLastSavedRef.current.content;

    var wsSnap = wsScope.getSnapshot();
    var wsValue = (wsSnap && wsSnap.value && typeof wsSnap.value === 'object') ? wsSnap.value : {};
    var workspaces = (wsValue.workspaces && typeof wsValue.workspaces === 'object') ? wsValue.workspaces : {};
    // 列表主源：workspace-registry-active.active（活跃投影）；workspace-prompt.workspaces 仅用于读写配置

    var actSnap = activeScope.getSnapshot();
    var actValue = (actSnap && actSnap.value && typeof actSnap.value === 'object') ? actSnap.value : {};
    var activeList = Array.isArray(actValue.active) ? actValue.active : [];
    var removedList = Array.isArray(wsValue.removed) ? wsValue.removed : [];
    // 行来源 = 活跃投影 ∪ 已配置工作区。只列活跃会让「没有在线会话的工作区」永远无法编辑
    // （inactive 文案/分支此前是不可达的死代码），而 remove 之后行仍在也让人以为移除没生效。
    var rows = [];
    var seenPath = {};
    for (var ai = 0; ai < activeList.length; ai++) {
      var ap = activeList[ai].path;
      if (seenPath[ap]) continue;
      seenPath[ap] = true;
      rows.push({ path: ap, sessionCount: activeList[ai].sessionCount, active: true });
    }
    var configuredPaths = Object.keys(workspaces);
    for (var ci = 0; ci < configuredPaths.length; ci++) {
      var cp = configuredPaths[ci];
      if (seenPath[cp]) continue;
      // 已被用户移除、且当前没有活跃会话的路径：不再显示（有活跃会话时仍保留行，
      // 因为那是把它配置回来的唯一入口）。
      if (removedList.indexOf(cp) !== -1) continue;
      seenPath[cp] = true;
      rows.push({ path: cp, sessionCount: 0, active: false });
    }

    function removeWorkspace(pathKey) {
      var remS = wsScope.getSnapshot();
      var remV = (remS && remS.value && typeof remS.value === 'object') ? remS.value : {};
      var remWs = (remV.workspaces && typeof remV.workspaces === 'object') ? { ...remV.workspaces } : {};
      var remRd = Array.isArray(remV.removed) ? remV.removed.slice() : [];
      delete remWs[pathKey];
      if (remRd.indexOf(pathKey) === -1) remRd.push(pathKey);
      // P2-1：先写 removed 再写 workspaces——即使 workspaces 写失败，removed 已记录也会阻止 sync 补回，移除不失效
      Promise.resolve(wsScope.set('removed', remRd)).then(function () {
        return wsScope.set('workspaces', remWs);
      }).then(function () {
        // 读回校验：removed 已记录且 workspaces 已删除，二者一致才算成功
        var s2 = wsScope.getSnapshot();
        var v2 = (s2 && s2.value && typeof s2.value === 'object') ? s2.value : {};
        var ws2 = (v2.workspaces && typeof v2.workspaces === 'object') ? v2.workspaces : {};
        var rd2 = Array.isArray(v2.removed) ? v2.removed : [];
        var ok = ws2[pathKey] === undefined && rd2.indexOf(pathKey) !== -1;
        if (!ok) console.warn('[dsh-global-prompt] removeWorkspace verification failed for ' + pathKey);
      }).catch(function (e) {
        console.warn('[dsh-global-prompt] removeWorkspace failed for ' + pathKey + ': ' + String(e && e.message ? e.message : e));
      });
    }

    return React.createElement('div', { className: 'dsw-page' },
      React.createElement('div', { className: 'dsw-card', tabIndex: -1 },
        React.createElement('header', { className: 'dsw-head' },
          React.createElement('div', { className: 'dsw-title-row' },
            React.createElement('div', { className: 'dsw-title-group' },
              React.createElement(primitives.IconGlobeOutlineRegular, { size: 18 }),
              React.createElement('h1', { className: 'dsw-title' }, t('title'))),
            React.createElement(primitives.Pill, { active: gEnabled, className: 'dsw-badge' + (gEnabled ? ' dsw-badge-on' : ' dsw-badge-off') }, gEnabled ? t('badgeOn') : t('badgeOff'))),
          React.createElement('p', { className: 'dsw-desc' }, t('desc'))),

        React.createElement('div', { className: 'dsw-scope-note' }, t('scopeOrder')),

        React.createElement(TabBar, { t: t, tab: tab, onTab: setTab }),

        tab === 'global'
          ? React.createElement('div', { className: 'dsw-stack', onKeyDown: onGlobalKeyDown },
              React.createElement(SwitchRow, {
                t: t,
                enabled: gEnabled,
                onToggle: function () { saveGlobalEnabled(!gEnabled); },
                label: t('enableLabel'),
                hint: t('enableHint'),
              }),
              React.createElement('div', { className: 'dsw-content' + (gDisabled ? ' dsw-disabled' : '') },
                React.createElement('div', { className: 'dsw-label-row' },
                  React.createElement('label', { className: 'dsw-label', htmlFor: 'dsw-global-area' }, t('contentLabel')),
                  React.createElement('span', { className: gCountClass }, String(gCount) + ' ' + t('charUnit'))),
                React.createElement('textarea', { id: 'dsw-global-area', className: 'dsw-area', value: gContent, disabled: gDisabled, spellCheck: false, placeholder: t('placeholder'), onChange: onChangeContent })),
              React.createElement(FileRefsPanel, { t: t, files: gFiles, onFilesChange: onFilesChange, statuses: gFileStatus }),
              React.createElement('div', { className: 'dsw-actions' },
                React.createElement('span', { className: 'dsw-autosave', role: 'status' }, gAutoSave === 'saved' ? t('autoSaved') : (gAutoSave === 'saving' ? t('saving') : '')),
                React.createElement(primitives.Button, { variant: 'ghost', onClick: function () {
                  if (gAutoTimerRef.current) { gAutoTimerRef.current(); gAutoTimerRef.current = null; }
                  setGEnabled(false); setGContent('');
                  Promise.resolve(scope.set('enabled', false)).then(function () {
                    return scope.set('content', '');
                  }).then(function () {
                    gLastSavedRef.current = { enabled: false, content: '' };
                    setGAutoSave('saved');
                  }).catch(function (e) { console.warn('[dsh-global-prompt] reset settings failed', e); });
                } }, t('reset'))),
              gToast ? React.createElement(Toast, { toast: gToast, t: t }) : null)
          : React.createElement('div', { className: 'dsw-workspace' },
              rows.length === 0
                ? React.createElement('div', { className: 'dsw-empty' },
                    React.createElement(primitives.IconArchiveOutlineRegular, { size: 20 }),
                    React.createElement('div', { className: 'dsw-empty-title' }, t('emptyWorkspaces')),
                    React.createElement('div', { className: 'dsw-empty-hint' }, t('emptyHint')))
                : React.createElement('div', { className: 'dsw-ws-list' }, rows.map(function (item) {
                    return React.createElement(WorkspaceRow, { key: item.path, t: t, path: item.path, ctx: ctx, wsScope: wsScope, fsStatusScope: fsStatusScope, active: item.active, removed: removedList.indexOf(item.path) !== -1, sessionCount: item.sessionCount, onRemove: removeWorkspace });
                  })))));
  }

  function injectCss() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('dsh-global-prompt-css')) return;
    var style = document.createElement('style');
    style.id = 'dsh-global-prompt-css';
    style.setAttribute('data-plugin', 'dsh-global-prompt');
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function apply(ctx, cfg) {
    // cfg 即 uiCfg（client.* 表单快照 / 兜底默认值），字符上限在使用处读取。
    injectCss();
    var locale = ctx.get('locale');
    var slots = ctx.get('slots');
    var form = configForm(ctx);
    if (!slots || !form) return;

    var t = function (key) { return zh[key] || key; };
    if (locale) {
      ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }); }, 'dsh-global-prompt: locale');
      t = locale.bind(NS);
    }

    // 全局/工作区提示词 = 本条目 config 的两段；活跃工作区与引用文件状态 = host 只读状态路由
    var scope = sectionOf(form, ['globalPrompt']);
    var wsScope = sectionOf(form, ['workspacePrompt']);
    var fsStatusScope = runtimeScope(ctx, 'fileStatus');
    var activeScope = runtimeScope(ctx, 'active');
    slots.inject('settings.section', function () {
      return slots.register({
        name: 'settings.section',
        id: 'global-prompt',
        order: 30,
        label: function () { return t('nav'); },
        locale: NS,
      }, function () {
        return React.createElement(GlobalPromptPage, { t: t, scope: scope, wsScope: wsScope, activeScope: activeScope, fsStatusScope: fsStatusScope, ctx: ctx });
      });
    });
  }

  var CSS = [
    '.dsw-page{--dsw-bg-page:var(--dsw-alias-bg-base);--dsw-bg-card:var(--dsw-alias-bg-layer-1);--dsw-border-l1:var(--dsw-alias-border-l1);--dsw-border-l2:var(--dsw-alias-border-l2);--dsw-text-title:var(--dsw-alias-label-primary);--dsw-text-body:var(--dsw-alias-label-secondary);--dsw-text-sub:var(--dsw-alias-label-tertiary);--dsw-success-text:var(--dsw-alias-state-success-primary);--dsw-warn:var(--dsw-alias-state-warn-label);--dsw-error:var(--dsw-alias-state-error-primary);--dsw-alias-button-primary-fill:var(--dsw-alias-state-business-primary);--dsw-alias-button-primary-hover:var(--dsw-static-deepseek-400);background:var(--dsw-bg-page);min-height:100%;display:flex;flex-direction:column;padding:0;box-sizing:border-box;font-family:var(--dsw-font-family);color:var(--dsw-text-title);font-size:14px;line-height:1.6;transition:background .2s ease,color .2s ease}',
    '.dsw-card{width:100%;flex:1;background:var(--dsw-bg-card);border:0;border-radius:12px;box-shadow:var(--dsw-elevation-panel);padding:24px 28px;display:flex;flex-direction:column;gap:18px;box-sizing:border-box;transition:background .2s ease,box-shadow .2s ease}',
    '.dsw-card>*{flex-shrink:0}',
    '.dsw-head{display:flex;flex-direction:column;gap:6px}',
    '.dsw-title-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
    '.dsw-title-group{display:flex;align-items:center;gap:8px;min-width:0}',
    '.dsw-title{margin:0;font-size:20px;font-weight:600;color:var(--dsw-text-title);line-height:1.3;transition:color .2s ease}',
    '.dsw-badge{height:24px;line-height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}',
    '.dsw-page .dsw-badge-on{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
    '.dsw-page .dsw-badge-off{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
    '.dsw-desc{margin:0;font-size:14px;line-height:1.6;color:var(--dsw-text-body);transition:color .2s ease}',
    '.dsw-scope-note{font-size:12px;line-height:1.6;color:var(--dsw-text-sub);background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:8px 12px;transition:color .2s ease,background .2s ease}',
    '.dsw-tabs{display:flex;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
    '.dsw-tab{height:34px;padding:0 14px;border:none;border-radius:8px 8px 0 0;background:transparent;color:var(--dsw-text-sub);font-family:var(--dsw-font-family);font-size:14px;font-weight:500;cursor:pointer;transition:background .2s ease,color .2s ease;border-bottom:2px solid transparent}',
    '.dsw-tab:hover{color:var(--dsw-text-title);background:var(--dsw-alias-interactive-bg-hover)}',
    '.dsw-tab.active{color:var(--dsw-text-title);border-bottom-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
    '.dsw-stack{display:flex;flex-direction:column;gap:16px}',
    '.dsw-enable{display:flex;align-items:flex-start;gap:12px}',
    '.dsw-switch{position:relative;flex:none;width:40px;height:22px;margin-top:2px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .2s ease;box-sizing:border-box}',
    '.dsw-switch.on{background:var(--dsw-alias-state-business-primary)}',
    '.dsw-switch-thumb{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);box-shadow:0 1px 2px rgba(0,0,0,.15);transition:transform .2s ease}',
    '.dsw-switch.on .dsw-switch-thumb{transform:translateX(18px)}',
    '.dsw-enable-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.dsw-enable-label{font-size:14px;font-weight:500;color:var(--dsw-text-title);transition:color .2s ease}',
    '.dsw-enable-hint{font-size:12px;color:var(--dsw-text-sub);transition:color .2s ease}',
    '.dsw-content{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;transition:opacity .2s ease}',
    '.dsw-content.dsw-disabled{opacity:.45;pointer-events:none}',
    '.dsw-label-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
    '.dsw-label{font-size:14px;font-weight:500;color:var(--dsw-text-title);transition:color .2s ease}',
    '.dsw-count{font-size:12px;color:var(--dsw-text-sub);font-variant-numeric:tabular-nums;transition:color .2s ease}',
    '.dsw-count-warn{color:var(--dsw-warn)}',
    '.dsw-count-error{color:var(--dsw-error)}',
    '.dsw-area{width:100%;flex:1;min-height:240px;padding:12px;box-sizing:border-box;border:1px solid var(--dsw-border-l2);border-radius:8px;background:var(--dsw-bg-card);font-family:var(--dsw-font-family);font-size:14px;line-height:1.7;color:var(--dsw-text-title);resize:vertical;transition:border-color .2s ease,box-shadow .2s ease,background .2s ease,color .2s ease}',
    '.dsw-area::placeholder{color:var(--dsw-text-sub)}',
    '.dsw-area:focus{outline:none;border-color:var(--dsw-border-l2);box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover-accent)}',
    '.dsw-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px}',
    '.dsw-unsaved{font-size:12px;color:var(--dsw-warn);transition:color .2s ease}',
    '.dsw-workspace{display:flex;flex-direction:column}',
    '.dsw-ws-list{display:flex;flex-direction:column;gap:8px}',
    '.dsw-ws-badge{flex:none;height:20px;line-height:20px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:12px;font-weight:500;white-space:nowrap;margin-left:8px}',
    '.dsw-ws-body{display:flex;flex-direction:column;gap:14px;padding:4px 0 4px 2px}',
    '.dsw-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:56px 24px;text-align:center;color:var(--dsw-text-sub)}',
    '.dsw-empty-title{font-size:14px;font-weight:500;color:var(--dsw-text-body)}',
    '.dsw-empty-hint{font-size:12px;color:var(--dsw-text-sub);max-width:380px;line-height:1.6}',
    '.dsw-removed-hint{font-size:12px;color:var(--dsw-warn);transition:color .2s ease}',
    '.dsw-files{display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-family:var(--dsw-font-family)}',
    '.dsw-files-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
    '.dsw-files-list{display:flex;flex-direction:column;gap:4px}',
    '.dsw-file-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);transition:background .2s ease}',
    '.dsw-file-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.dsw-file-path{flex:1;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsw-file-status{flex:none;font-size:12px;font-weight:500;line-height:20px;height:20px;padding:0 8px;border-radius:999px;white-space:nowrap}',
    '.dsw-file-status.ok{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
    '.dsw-file-status.fail{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
    '.dsw-file-status.pending{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
    '.dsw-file-remove{flex:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1;padding:0 4px;border-radius:4px;transition:background .15s ease,color .15s ease}',
    '.dsw-file-remove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}',
    '.dsw-files-add{display:flex;gap:8px}',
    '.dsw-file-input{flex:1;min-width:0;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px}',
    '.dsw-file-input::placeholder{color:var(--dsw-alias-label-secondary)}',
    '.dsw-file-input:focus{outline:none;border-color:var(--dsw-alias-border-l2);box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover-accent)}',
    '.dsw-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:8px;padding:10px 20px;border-radius:8px;background:var(--dsw-bg-card);border:0;box-shadow:var(--dsw-elevation-prominent);font-size:14px;font-family:var(--dsw-font-family);animation:dsw-toast-in .2s ease;transition:background .2s ease}',
    '.dsw-toast.ok{color:var(--dsw-success-text)}',
    '.dsw-toast.err{color:var(--dsw-error)}',
    '.dsw-busy{padding:48px 24px;text-align:center;color:var(--dsw-text-body)}',
    '.dsw-busy-err{color:var(--dsw-error)}',
    '@keyframes dsw-spin{to{transform:rotate(360deg)}}',
    '@keyframes dsw-toast-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}',
    '',
  ].join('\n');

  var name = 'dsh-global-prompt';
  var inject = ['slots', 'locale', 'configForms', 'timer'];
collect('global-prompt', apply);
  exports.name = name;
    })();

    // ===== 模块 3：重启服务（web-restart，settings.general.item + 覆盖层）=====
    (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');
    var react_jsx_runtime = require('react/jsx-runtime');

    var NS = 'web-restart-ui';
    // 重启覆盖层可调参数来自 session-toolkit-ui 命名空间（见 factory 顶部 uiCfg），使用时读取。
    function restartTimeoutMs() { return uiCfg.restartTimeoutMs; }
    function restartPollMs() { return uiCfg.restartPollMs; }
    function restartFillMs() { return uiCfg.restartFillMs; }
    // 连续失败阈值：达到该次数才判定"观测到服务器中断"，防单次网络抖动假中断
    function restartFailThreshold() { return uiCfg.restartFailThreshold; }
    // 恢复后再额外等待的稳定窗口（ms）：给 DSH 后端会话数据就绪留时间，避免 reload 过早导致导航栏标题 fallback
    function restartSettleMs() { return uiCfg.restartSettleMs; }

    var zh = {
      label: '重启服务',
      desc: '重启 DeepSeek Harness 服务；当前页面将显示进度并在完成后自动刷新。',
      restarting: '正在重启 DeepSeek Harness…',
      phase0: '正在发送重启请求…',
      phase1: '正在停止服务…',
      phase2: '正在启动服务…',
      phase3: '正在恢复连接…',
      ready: '服务已恢复，即将刷新…',
      noRestart: '未检测到服务重启，可能重启脚本未执行；请手动刷新。',
      timeout: '重启超时，请检查服务或手动刷新。',
      restartRejected: '重启请求被拒绝',
      refresh: '手动刷新',
    };

    var en = {
      label: 'Restart Service',
      desc: 'Restart the DeepSeek Harness service; this page will show progress and refresh automatically when done.',
      restarting: 'Restarting DeepSeek Harness…',
      phase0: 'Sending restart request…',
      phase1: 'Stopping service…',
      phase2: 'Starting service…',
      phase3: 'Restoring connection…',
      ready: 'Service restored, refreshing…',
      noRestart: 'No restart detected. The restart script may not have run; refresh manually.',
      timeout: 'Restart timed out. Check the service or refresh manually.',
      restartRejected: 'Restart request rejected',
      refresh: 'Refresh now',
    };

    /**
     * 全屏重启覆盖层（中断恢复探测版）：
     * - 进入立即 5%（请求已发送）；轮询失败期间 progress = 5 + min(85, elapsedSec/90*85) 平滑渐近 90% 上限；
     * - 轮询（restartPollMs）GET /api/restart：失败（reject/!ok）连续达到 restartFailThreshold 次 → interruptedRef=true（观测到中断）；
     * - 成功且 interruptedRef 为 true → 判定"真重启完成"（中断后恢复）→ progress 90→100 约 600ms 补满 → location.reload()；
     * - 成功但 interruptedRef 为 false → 全程可达，判定"可能未重启"，不 reload，继续轮询至超时；
     * - 90s 超时兜底：从未中断（全程可达）显示 noRestart 提示，否则显示 timeout 提示，均提供手动刷新。
     */
    function RestartOverlay(props) {
      var t = props.t;
      var ctx = props.ctx;
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useRef = react.useRef;
      var startRef = useRef(Date.now());
      var detectedAtRef = useRef(null);
      var interruptedRef = useRef(false);
      var failCountRef = useRef(0);
      var tickState = useState(0);
      var detectedState = useState(false);
      var timedOutState = useState(false);
      var noRestartState = useState(false);
      var detected = detectedState[0], setDetected = detectedState[1];
      var timedOut = timedOutState[0], setTimedOut = timedOutState[1];
      var noRestart = noRestartState[0], setNoRestart = noRestartState[1];

      useEffect(function () {
        // 定时器走 timer 服务（ctx.timeout/ctx.interval）：插件 fiber 生命周期兜底；
        // cleanup 调用 disposer 停止（组件卸载即停，幂等）。
        var reloadTimer = null;
        var timeoutTimer = ctx.timeout(function () {
          setTimedOut(true);
          // 超时时区分：从未中断（全程可达）= 未检测到重启；中断过未恢复 = 重启未完成
          if (!interruptedRef.current) setNoRestart(true);
        }, restartTimeoutMs());
        // 轮询 GET /api/restart：失败连续达到阈值才判定"观测到中断"；中断后恢复才算真重启。
        var poll = ctx.interval(function () {
          fetch('/api/restart', { method: 'GET', cache: 'no-store' })
            .then(function (r) { return r.ok; })
            .catch(function () { return false; })
            .then(function (ok) {
              if (ok) {
                failCountRef.current = 0;
                if (interruptedRef.current) {
                  // 真重启（中断后恢复）→ 补满动画 → reload
                  detectedAtRef.current = Date.now();
                  setDetected(true);
                  poll();
                  timeoutTimer();
                  reloadTimer = ctx.timeout(function () { location.reload(); }, restartFillMs() + restartSettleMs());
                }
                // interruptedRef 为 false（全程可达）：可能是 stop 慢/脚本未执行，不 reload，继续等待
              } else {
                failCountRef.current += 1;
                if (failCountRef.current >= restartFailThreshold) {
                  interruptedRef.current = true;
                }
              }
            });
        }, restartPollMs());
        return function () {
          poll();
          timeoutTimer();
          if (reloadTimer !== null) reloadTimer();
        };
      }, []);

      // 每秒 tick 驱动进度条推进
      useEffect(function () {
        var iv = ctx.interval(function () { tickState[1](function (x) { return x + 1; }); }, restartPollMs());
        return function () { iv(); };
      }, []);

      // 探测驱动：未成功时平滑渐近 90% 上限；成功后 600ms 补满 90→100
      var elapsedMs = Date.now() - startRef.current;
      var elapsedSec = elapsedMs / 1000;
      var progress;
      if (detected && detectedAtRef.current !== null) {
        progress = Math.min(100, 90 + ((Date.now() - detectedAtRef.current) / restartFillMs()) * 10);
      } else {
        progress = 5 + Math.min(85, (elapsedSec / 90) * 85);
      }

      // 阶段文案与进度解耦：按 elapsed 细化
      var phaseKey;
      if (detected) phaseKey = 'phase3';
      else if (elapsedSec < 3) phaseKey = 'phase0';
      else if (elapsedSec < 10) phaseKey = 'phase1';
      else phaseKey = 'phase2';

      return react_jsx_runtime.jsxs('div', {
        className: 'wr-mask',
        role: 'status',
        'aria-live': 'polite',
        children: [
          react_jsx_runtime.jsxs('div', {
            className: 'wr-card',
            children: [
              react_jsx_runtime.jsx('h1', { className: 'wr-title', children: t('restarting') }),
              react_jsx_runtime.jsx('div', { className: 'wr-progress', children: react_jsx_runtime.jsx('div', { className: 'wr-progress-fill', style: { width: String(Math.min(100, progress)) + '%' } }) }),
              react_jsx_runtime.jsx('div', { className: 'wr-phase', children: detected ? t('ready') : t(phaseKey) }),
              timedOut ? react_jsx_runtime.jsxs('div', {
                className: 'wr-timeout',
                children: [
                  react_jsx_runtime.jsx('div', { children: t(noRestart ? 'noRestart' : 'timeout') }),
                  react_jsx_runtime.jsx('button', { type: 'button', className: 'wr-refresh', onClick: function () { location.reload(); }, children: t('refresh') }),
                ],
              }) : null,
            ],
          }),
        ],
      });
    }

    /** 通用设置条目：说明 + 「重启服务」按钮；点击后进入全屏覆盖层。 */
    function WebRestartItem(props) {
      var t = props.t;
      var ctx = props.ctx;
      var useState = react.useState;
      var phaseState = useState('idle');
      var phase = phaseState[0], setPhase = phaseState[1];
      var errState = useState(null);
      var err = errState[0], setErr = errState[1];
      // 可用性探测：GET /api/restart 回报 { ok, available }；非 Windows（或路由不存在、
      // 探测失败）时不渲染入口——此前的形态是入口照常显示、点一次后覆盖层空转到 90s 超时。
      var availState = useState('probing');
      var avail = availState[0], setAvail = availState[1];

      react.useEffect(function () {
        var cancelled = false;
        fetch('/api/restart', { method: 'GET', cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (cancelled) return;
            setAvail(j && j.available === false ? 'unavailable' : (j ? 'available' : 'unavailable'));
          })
          .catch(function () { if (!cancelled) setAvail('unavailable'); });
        return function () { cancelled = true; };
      }, []);

      if (avail !== 'available') return null;

      function onClick() {
        if (phase !== 'idle') return;
        setErr(null);
        // 只有拿到 202 才进入覆盖层：409（已在重启中）、500（脚本缺失/无法自动重启）、
        // 501（平台不支持）、404（路由缺失）都在这里立即报错，而不是让覆盖层空转到超时。
        fetch('/api/restart', { method: 'POST', cache: 'no-store' })
          .then(function (r) {
            if (r.status === 202) { setPhase('restarting'); return null; }
            return r.json().catch(function () { return null; }).then(function (body) {
              var detail = (body && body.error) ? body.error : ('HTTP ' + r.status);
              setErr(t('restartRejected') + ': ' + detail);
            });
          })
          .catch(function (e) {
            setErr(t('restartRejected') + ': ' + (e && e.message ? e.message : String(e)));
          });
      }

      return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
        children: [
          react_jsx_runtime.jsxs('div', {
            className: 'wr-item',
            children: [
              react_jsx_runtime.jsxs('div', {
                className: 'wr-item-text',
                children: [
                  react_jsx_runtime.jsx('div', { className: 'wr-item-label', children: t('label') }),
                  react_jsx_runtime.jsx('div', { className: 'wr-item-desc', children: t('desc') }),
                ],
              }),
              react_jsx_runtime.jsx('button', { type: 'button', className: 'wr-item-btn', disabled: phase !== 'idle', onClick: onClick, children: t('label') }),
            ],
          }),
          err ? react_jsx_runtime.jsx('div', { className: 'wr-item-error', role: 'status', children: err }) : null,
          phase === 'restarting' ? react_jsx_runtime.jsx(RestartOverlay, { t: t, ctx: ctx }) : null,
        ],
      });
    }

    var inject = ['slots', 'locale', 'timer'];

    function apply(ctx, cfg) {
      // cfg 即 uiCfg（session-toolkit-ui 快照 / 兜底默认值），参数在使用处读取。
      injectCss();
      var locale = ctx.get('locale');
      var slots = ctx.get('slots');
      if (!slots) return;
      var t = function (key) { return zh[key] || key; };
      if (locale) {
        ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }); }, 'dsh-web-restart: locale');
        t = locale.bind(NS);
      }
      slots.inject('settings.general.item', function () {
        return slots.register({
          name: 'settings.general.item',
          id: 'web-restart',
          order: 90,
          label: function () { return t('label'); },
          locale: NS,
        }, function () {
          return react_jsx_runtime.jsx(WebRestartItem, { t: t, ctx: ctx });
        });
      });
    }

    function injectCss() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('dsh-web-restart-css')) return;
      var style = document.createElement('style');
      style.id = 'dsh-web-restart-css';
      style.setAttribute('data-plugin', 'dsh-web-restart');
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    var CSS = [
      '.wr-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0}',
      '.wr-item-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.wr-item-label{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.wr-item-desc{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.wr-item-error{font-size:12px;color:var(--dsw-alias-state-error-primary);padding:0 0 8px}',
      '.wr-item-btn{flex:none;height:32px;padding:0 16px;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:#fff;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .2s ease}',
      '.wr-item-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.wr-item-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.wr-mask{position:fixed;inset:0;z-index:20000;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}',
      '.wr-card{width:420px;max-width:100%;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:32px 28px;box-sizing:border-box;text-align:center;color:var(--dsw-alias-label-primary,#1F2329)}',
      '.wr-title{font-size:18px;font-weight:600;margin:0 0 20px;line-height:1.4}',
      '.wr-progress{height:8px;border-radius:4px;background:var(--dsw-alias-border-l2);overflow:hidden;margin-bottom:12px}',
      '.wr-progress-fill{height:100%;border-radius:4px;background:var(--dsw-alias-button-primary-fill);transition:width .4s ease}',
      '.wr-phase{font-size:13px;color:var(--dsw-alias-label-secondary,#646A73)}',
      '.wr-timeout{margin-top:16px;display:flex;flex-direction:column;gap:12px;align-items:center;font-size:13px;color:var(--dsw-alias-state-error-primary)}',
      '.wr-refresh{height:32px;padding:0 16px;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:#fff;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500}',
      '.wr-refresh:hover{background:var(--dsw-alias-button-primary-hover)}',
      'body[data-ds-dark-theme] .wr-mask{background:rgba(0,0,0,.6)}',
    ].join('\n');

collect('web-restart', apply);
    })();

    // ===== 模块 4：Session log 平移（log-reposition，遮蔽 utilities + actions 复刻）=====
    (function () {
    var module = { exports: {} };
    var exports = module.exports;
    // 本块用 react.useState / react.useEffect（组件自身状态），而 react/jsx-runtime 不提供 react，
    // 二者是两条 require；此前只引了后者 ⇒ 渲染到 SessionLogDownloadHeaderAction 时整块崩掉。
    var react = require('react');
    var react_jsx_runtime = require('react/jsx-runtime');
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    var runtime_client = require('@deepseek-ai/dsh-client-store');

    // 独立 NS：复制官方文案（dialog + menu/header），避免与官方 NS 'session-log-download' 重复注册冲突。
    // 【随 DSH 升级复核】本模块复刻官方 session-log-export 的浏览器半（0.1.6-alpha.2 形态：
    // utilities 里的「⋯ 更多操作」菜单 + 共享 Dialog），官方改版时必须同步，否则被遮蔽的官方
    // 入口会连同新功能一起消失。
    var NS = 'session-log-reposition';
    var zh = {
      'header.more': '更多操作',
      'menu.download': '下载 Session 日志',
      'dialog.preparingTitle': '正在导出 Session',
      'dialog.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
      'dialog.successTitle': 'Session 导出已开始下载',
      'dialog.successDescription': '浏览器正在下载 Session ZIP 文件。',
      'dialog.errorTitle': 'Session 导出失败',
      'dialog.close': '关闭',
      'dialog.commandFailed': '无法启动 Session 导出。',
    };
    var en = {
      'header.more': 'More actions',
      'menu.download': 'Download session log',
      'dialog.preparingTitle': 'Exporting Session',
      'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
      'dialog.successTitle': 'Session download started',
      'dialog.successDescription': 'The browser is downloading the Session ZIP.',
      'dialog.errorTitle': 'Session export failed',
      'dialog.close': 'Close',
      'dialog.commandFailed': 'Could not start the Session export.',
    };

    // CSS：复制官方 HeaderAction.module.css 的 .moreButton 规则，类名换前缀防撞
    var css = '.slr-moreButton{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:28px;cursor:pointer}.slr-moreButton svg{width:15px;height:15px}.slr-moreButton:hover{background:var(--dsw-alias-interactive-bg-hover)}';
    var cssTagId = 'dsh-session-log-reposition/HeaderAction.module.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-session-log-reposition';
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /**
     * 复制的官方 Dialog：状态文案来自本插件的 NS，控制器状态/动作走官方 controller。
     * @param props - Session runtime、controller 绑定（useSessionLogDownload）、动作与本地化文案。
     */
    function SessionLogDownloadDialog(props) {
      var sessionId = props.sessionId;
      var useSessionLogDownload = props.useSessionLogDownload;
      var dismiss = props.dismiss;
      var t = props.t;
      var entry = useSessionLogDownload(function (state) { return state.bySession[String(sessionId)]; });
      var status = entry ? entry.status : undefined;
      var open = entry ? entry.open === true : false;
      var error = status === 'error' ? (entry && entry.error ? entry.error : t('dialog.commandFailed')) : null;
      return react_jsx_runtime.jsx(primitives.Modal, {
        open: open,
        onClose: function () { dismiss(sessionId); },
        title: status === 'downloading' ? t('dialog.preparingTitle') : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle'),
        description: status === 'downloading' ? t('dialog.preparingDescription') : status === 'success' ? t('dialog.successDescription') : (error !== null ? error : t('dialog.commandFailed')),
        closeLabel: t('dialog.close'),
        footer: react_jsx_runtime.jsx(primitives.Button, {
          variant: 'primary',
          onClick: function () { dismiss(sessionId); },
          children: t('dialog.close'),
        }),
      });
    }

    /**
     * 复制的官方「⋯ 更多操作」菜单（0.1.6 形态）+ 共享 Dialog；
     * 状态与动作全部转发官方 sessionLogDownload controller。
     */
    function SessionLogDownloadHeaderAction(props) {
      var sessionId = props.sessionId;
      var useSessionLogDownload = props.useSessionLogDownload;
      var request = props.request;
      var t = props.t;
      var busyEntry = useSessionLogDownload(function (state) { return state.bySession[String(sessionId)]; });
      var busy = busyEntry ? busyEntry.status === 'downloading' : false;
      var openState = react.useState(false);
      var open = openState[0], setOpen = openState[1];
      return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
        children: [
          react_jsx_runtime.jsx(primitives.Menu, {
            open: open,
            align: 'end',
            dense: true,
            onClose: function () { setOpen(false); },
            items: [{
              id: 'download',
              label: t('menu.download'),
              icon: react_jsx_runtime.jsx(primitives.IconDownloadOutlineRegular, { size: 16 }),
              disabled: busy,
            }],
            onSelect: function () { setOpen(false); void request(sessionId); },
            anchor: react_jsx_runtime.jsx('button', {
              type: 'button',
              className: 'slr-moreButton',
              'aria-label': t('header.more'),
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              'aria-busy': busy,
              onClick: function () { setOpen(function (value) { return !value; }); },
              children: react_jsx_runtime.jsx(primitives.IconEllipsisOutlineRegular, { size: 16 }),
            }),
          }),
          react_jsx_runtime.jsx(SessionLogDownloadDialog, Object.assign({}, props)),
        ],
      });
    }

    // 惰性获取 controller 的兜底：官方未 provide 时用空 store（uSES 合法形态）保证组件不崩，
    // request/dismiss 置空操作；正常加载顺序下渲染必然晚于所有 apply，官方必已 provide。
    var fallbackStore = null;
    var warnedOnce = false;
    function getFallbackStore() {
      if (fallbackStore === null) fallbackStore = runtime_client.createSnapshotStore({ bySession: {} });
      return fallbackStore;
    }

    var inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, 'dsh-session-log-reposition: locale');

      // 遮蔽：utilities 槽同 id、priority -1（低于官方默认 0 → 最低者渲染），组件渲染 null
      ctx.slots.inject('conversation.session.header.utilities', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'session-log-download',
          priority: -1,
          locale: NS,
        }, function () { return null; });
      });

      // 平移：actions 槽 order 41（身份按钮 40 之后），inject 转发官方 controller（惰性获取）
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'session-log-download-moved',
          order: 41,
          locale: NS,
          inject: function () {
            var controller = ctx.get('sessionLogDownload');
            if (controller === undefined) {
              if (!warnedOnce) {
                warnedOnce = true;
                console.warn('[dsh-session-log-reposition] sessionLogDownload controller unavailable; download is a no-op until it appears');
              }
              return {
                hooks: { sessionLogDownload: getFallbackStore() },
                request: function () {},
                dismiss: function () {},
              };
            }
            return {
              hooks: { sessionLogDownload: controller.store },
              request: function (sessionId) { return controller.download(sessionId); },
              dismiss: function (sessionId) { controller.dismiss(sessionId); },
            };
          },
        }, SessionLogDownloadHeaderAction);
      });
    }

collect('log-reposition', apply);
    })();

    // ===== 模块 5：复制会话 ID（peer-message，header + input.left 按钮）=====
    (function () {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require('react');
    let react_jsx_runtime = require('react/jsx-runtime');
    let primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    var NS = 'peer-message-ui';
    var zh = { copied: '已复制', copy: '复制会话 ID' };
    var en = { copied: 'Copied', copy: 'Copy session ID' };
    // 复制反馈时长来自 session-toolkit-ui（见 factory 顶部 uiCfg），使用时读取
    function copyFeedbackMs() { return uiCfg.copyFeedbackMs; }

    /** Header action: copy this session's id to the clipboard, with a brief check mark feedback. */
    function CopySessionIdAction({ sessionId, ctx, t }) {
      const [copied, setCopied] = react.useState(false);
      const timerRef = react.useRef(null);
      const onClick = () => {
        navigator.clipboard.writeText(String(sessionId)).then(() => {
          setCopied(true);
          if (timerRef.current !== null) timerRef.current();
          timerRef.current = ctx.timeout(() => setCopied(false), copyFeedbackMs());
        }).catch((error) => {
          console.error('[peer-message] copy session id failed:', error);
        });
      };
      // 组件卸载时清理 timer disposer（ctx.timeout 属插件 fiber，组件卸载不自动清）
      react.useEffect(function () {
        return function () { if (timerRef.current !== null) timerRef.current(); };
      }, []);
      return react_jsx_runtime.jsx('button', {
        type: 'button',
        onClick,
        title: copied ? t('copied') : t('copy'),
        'aria-label': copied ? t('copied') : t('copy'),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          padding: 0,
          border: 'none',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer'
        },
        children: copied
          ? react_jsx_runtime.jsx(primitives.IconCheckOutlineRegular, { size: 16 })
          : react_jsx_runtime.jsx(primitives.IconCopyOutlineRegular, { size: 16 })
      });
    }

    const inject = ['slots', 'timer'];

    function apply(ctx, cfg) {
      var locale = ctx.get('locale');
      var t = function (k) { return zh[k] || k; };
      if (locale) {
        ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }); }, 'dsh-peer-message: locale');
        t = locale.bind(NS);
      }
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'copy-session-id',
        order: 30
      }, function (props) { return react_jsx_runtime.jsx(CopySessionIdAction, { sessionId: props.sessionId, ctx: ctx, t: t }); }));

      // 工具行入口（方案 A：空白会话可见性）：与 header.actions 并存，复用同一组件
      // order 30 先于身份按钮（40），与 header.actions 的 30/40 显式区分保持一致
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'copy-session-id-input',
        order: 30
      }, function (props) { return react_jsx_runtime.jsx(CopySessionIdAction, { sessionId: props.sessionId, ctx: ctx, t: t }); }));

      // 侧栏会话行「⋯」菜单里的一行「复制会话 ID」（裁定 #18）。
      // 槽位 `sidebar.workspaces.session.menu.item` 是**平台声明的扩展点**（不是我们发明的名字）：
      // harness `packages/client/ui-workspace/lib/types/client/contract/slots.d.ts` :127 声明，
      // :113-124 给出官方示例；shipped 四项（置顶/重命名/分叉/归档）走同一槽位，本行以 order 500 排在它们之后。
      // 槽位契约（同文件 :128-137）：kind 'list'、scope 'root'、owner SessionRowOwnerProps、hookContext MenuOpenState。
      // 宿主把 hookContext 按 `standardHookPropName` 转成渲染 prop（ui-slots 的
      // `use<Name>`：menuOpenState → useMenuOpenState），UI 组件用 `const [, setMenuOpen] = useMenuOpenState()` 关菜单。
      // ⚠️ id 用包名命名空间——官方文档示例里的 `copy-session-id` 是**裸名**，我们自己的行不能占用它
      //   （复用 shipped id 会在另一 priority 上遮蔽那一行）。
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'dsh-session-toolkit.copy-session-id',
        order: 500
      }, function (props) {
        // hooks 面按名字转成 prop 后是 `useMenuOpenState`（函数）；这里兼容两种形态，
        // 且缺失时**出声**而不是静默——本插件已两次栽在「渲染期抛错被 slot 错误边界吞掉」上。
        var hook = props && props.useMenuOpenState;
        var setMenuOpen = null;
        if (typeof hook === 'function') setMenuOpen = hook()[1];
        else if (hook && typeof hook.menuOpenState === 'function') setMenuOpen = hook.menuOpenState()[1];
        else if (hook && typeof hook.menuOpenState === 'object') setMenuOpen = hook.menuOpenState.setMenuOpen;
        var onSelect = function () {
          // 先关菜单再复制：关菜单是同步的，复制是异步的，顺序不能反（否则菜单会停在打开态等 promise）
          if (typeof setMenuOpen === 'function') setMenuOpen(false);
          else if (typeof console !== 'undefined' && console.error) console.error('[peer-message] sidebar copy: useMenuOpenState hook unavailable — menu cannot be dismissed');
          var fail = function (error) { if (typeof console !== 'undefined' && console.error) console.error('[peer-message] sidebar copy session id failed:', error); };
          try {
            var copied = navigator.clipboard.writeText(String(props.sessionId));
            if (copied && typeof copied.then === 'function') copied.then(null, fail);
          } catch (error) { fail(error); }
        };
        return react_jsx_runtime.jsx(primitives.MenuItemButton, {
          separatorBefore: true,
          onSelect: onSelect,
          children: t('copy')
        });
      }));
    }

collect('peer-message', apply);
    })();

    function apply(ctx) {
      // UI 旋钮 = 本条目 config 的 client.* 字段：先读一次（表单可能仍在 loading，此时保持
      // 兜底值），再订阅补齐。订阅生命周期随本插件 fiber。
      var form = configForm(ctx);
      if (form) {
        readUiCfg(form);
        ctx.effect(function () {
          return form.subscribe(function () { readUiCfg(form); });
        }, 'dsh-session-toolkit: ui config');
      }
      var clientCfg = uiCfg;
      Object.keys(registered).forEach(function (tag) {
        try { registered[tag](ctx, clientCfg); } catch (e) { console.warn('[dsh-session-toolkit] client module ' + tag + ' apply failed: ' + (e && e.message ? e.message : String(e))); }
      });
    }
    var inject = ['slots', 'locale', 'configForms', 'timer'];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
