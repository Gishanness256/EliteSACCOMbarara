/* ==========================================================================
   Elite SACCO Mbarara — state.js
   Centralized app state, persistence and helpers.
   Safe for browser usage and CommonJS/test environments.

   Expected shape:
   ESACCO.S.users = [{ name, email, role, pw|hash, ... }]
   ESACCO.S.roles = { 'Admin': [...], 'Treasurer': [...], ... }
   ==========================================================================
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.ESACCOState = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const STORAGE_KEY = 'esacco_state_v1';

  const PERMS = [
    'Approve loans',
    'Acknowledge savings/deposits',
    'Acknowledge loan repayments',
    'Set interest rates',
    'Create/remove system users',
    'Create/remove member accounts',
    'Weekly reports',
    'Monthly reports',
    'Annual reports'
  ];

  const ROLES = ['Admin', 'Treasurer', 'Credit Supervisor', 'Credit Officer'];

  function defaultRoles() {
    const r = {};
    ROLES.forEach(role => {
      r[role] = PERMS.map((_, j) => {
        if (role === 'Admin') return true;
        if (role === 'Treasurer') return [1, 2, 6, 7, 8].includes(j);
        if (role === 'Credit Supervisor') return [0, 2, 3, 6, 7].includes(j);
        if (role === 'Credit Officer') return [1, 2].includes(j);
        return false;
      });
    });
    return r;
  }

  function createSeedState() {
    return {
      users: [
        {
          name: 'System Admin',
          email: 'admin@elitesacco.co.ug',
          role: 'Admin',
          pw: 'Admin',
          mustChange: true
        }
      ],
      members: [],
      savings: [],
      loans: [],
      roles: defaultRoles(),
      seq: 0,
      non: [],
      reqs: [],
      lseq: 0,
      audit: [],
      sseq: 0
    };
  }

  function safeStorage() {
    const mem = Object.create(null);

    function getStore() {
      try {
        if (root.localStorage && root.localStorage.getItem) {
          return root.localStorage;
        }
      } catch (e) {
        // ignore storage access errors
      }
      return {
        getItem(key) {
          return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
        },
        setItem(key, value) {
          mem[key] = String(value);
        },
        removeItem(key) {
          delete mem[key];
        }
      };
    }

    return getStore();
  }

  const storage = safeStorage();

  function clone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      return obj;
    }
  }

  function readState() {
    let state = createSeedState();

    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = Object.assign({}, createSeedState(), parsed);
      }
    } catch (e) {
      // ignore invalid JSON
    }

    state.non = Array.isArray(state.non) ? state.non : [];
    state.reqs = Array.isArray(state.reqs) ? state.reqs : [];
    state.audit = Array.isArray(state.audit) ? state.audit : [];
    state.users = Array.isArray(state.users) && state.users.length ? state.users : createSeedState().users;
    state.roles = state.roles && Object.keys(state.roles).length ? state.roles : defaultRoles();

    return state;
  }

  let S = readState();
  let cu = S.users && S.users.length ? S.users[0] : null;

  function save() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(S));
    } catch (e) {
      // ignore save failures
    }
  }

  function reset() {
    S = createSeedState();
    cu = S.users[0];
    save();
    return S;
  }

  function initials(user) {
    const source = user || cu || {};
    const name = source.name || '';
    return (source.ini || name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 3) || 'SYS');
  }

  function me() {
    return initials(cu);
  }

  function isAdmin(user) {
    const target = user || cu;
    return !!(target && target.role === 'Admin');
  }

  function audit(action, detail, user) {
    const actor = user || cu || { name: 'System', role: 'System' };
    const entry = {
      t: new Date().toISOString(),
      ini: initials(actor),
      user: actor.name || 'System',
      role: actor.role || 'System',
      act: action,
      part: detail || ''
    };

    S.audit = Array.isArray(S.audit) ? S.audit : [];
    S.audit.push(entry);
    if (S.audit.length > 5000) {
      S.audit.splice(0, S.audit.length - 5000);
    }
    save();
    return entry;
  }

  function can(permission, user) {
    const target = user || cu;
    if (!target || !target.role) return false;
    if (target.role === 'Admin') return true;
    const rolePerms = (S.roles && S.roles[target.role]) || [];
    if (!Array.isArray(rolePerms)) return false;
    const idx = typeof permission === 'number' ? permission : PERMS.indexOf(permission);
    if (idx < 0) return false;
    return !!rolePerms[idx];
  }

  function canView(viewName, user) {
    const target = user || cu;
    if (!target || !target.role) return false;

    const rules = {
      lreq: ['Admin', 'Credit Officer', 'Credit Supervisor'],
      lsec: ['Admin', 'Credit Officer', 'Credit Supervisor'],
      lapp: ['Admin'],
      audit: ['Admin', 'Treasurer'],
      users: ['Admin'],
      access: ['Admin']
    };

    if (!rules[viewName]) return true;
    return rules[viewName].includes(target.role);
  }

  function setCurrentUser(user) {
    cu = user || null;
    return cu;
  }

  function ensureRoleMatrix() {
    if (!S.roles || typeof S.roles !== 'object') {
      S.roles = defaultRoles();
    }
    Object.keys(defaultRoles()).forEach(role => {
      if (!S.roles[role]) {
        S.roles[role] = defaultRoles()[role];
      }
    });
  }

  function hydrate(nextState) {
    if (!nextState || typeof nextState !== 'object') return S;
    S = Object.assign({}, createSeedState(), nextState);
    ensureRoleMatrix();
    cu = (S.users && S.users.length) ? S.users[0] : null;
    save();
    return S;
  }

  const api = {
    STORAGE_KEY,
    PERMS,
    ROLES,
    defaultRoles,
    get state() {
      return S;
    },
    set state(nextState) {
      S = hydrate(nextState);
    },
    get currentUser() {
      return cu;
    },
    set currentUser(user) {
      setCurrentUser(user);
    },
    read: readState,
    save,
    reset,
    hydrate,
    initials,
    me,
    isAdmin,
    audit,
    can,
    canView,
    ensureRoleMatrix,
    get S() {
      return S;
    },
    set S(nextState) {
      hydrate(nextState);
    }
  };

  // Expose a global collection in the browser, while preserving app.js expectations.
  const globalNS = root.ESACCO || (root.ESACCO = {});
  Object.assign(globalNS, {
    get S() { return S; },
    set S(nextState) { hydrate(nextState); },
    get cu() { return cu; },
    set cu(user) { setCurrentUser(user); },
    save,
    reset,
    audit,
    initials,
    me,
    isAdmin,
    can,
    canView,
    PERMS,
    ROLES,
    defaultRoles
  });

  return api;
});
