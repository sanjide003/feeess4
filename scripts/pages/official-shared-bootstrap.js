import { signInAnonymously, onAuthStateChanged, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
    import { collection, doc, getDoc, getDocs } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
    import { db, auth } from '../../config/firebase-config.js';
    import { BASE_PATH, applyCachedInstitutionLogo, escapeHtml, rememberInstitutionLogo, sanitizeUrl } from '../shared/app-common.js';

    let allStudents = [];
    let allStaff = [];
    let studentGroups = [];
    let directoryEntries = [];
    let directoryCategories = [];
    let institutionConfig = {};
    let categoryAuthConfig = { categories: {} };
    let pageAccessConfig = { categories: {}, overrides: {} };
    let userSession = null;
    let authReady = false;
    const OFFICIAL_SESSION_KEY = 'official_portal_session_v1';
    
    applyCachedInstitutionLogo(['header-logo', 'official-login-modal-logo']);

    const officialFilters = { studentClass: '', studentGender: 'ALL', studentInfo: 'ALL', studentSearch: '', staffType: 'ALL', staffStatus: 'ALL', staffSearch: '' };

    // ==========================================
    // EXCEL SPREADSHEET BUILDER CONFIG
    // ==========================================
    let builderConfig = {
      classId: '', paper: 'A4', orientation: 'portrait', sortBy: 'name', groupBy: 'mixed',
      showHeader: false, repeatHeader: false, customTitle: '', activeTab: 'home',
      columns: [
        { id: 'col_sno', field: 'SNO', title: 'S.No', width: 'auto' },
        { id: 'col_name', field: 'name', title: 'Student Name', width: 'auto' },
        { id: 'col_c1', field: 'CUSTOM', title: 'Custom Sp.', width: '150px' },
        { id: 'col_c2', field: 'CUSTOM', title: 'Custom Sp.', width: '150px' },
        { id: 'col_c3', field: 'CUSTOM', title: 'Custom Sp.', width: '150px' }
      ]
    };

    let undoStack = [];
    let redoStack = [];

    const saveBuilderState = () => {
        const table = document.getElementById('builder-table');
        if (table) {
            undoStack.push(table.innerHTML);
            if (undoStack.length > 20) undoStack.shift(); 
            redoStack = [];
        }
    };

    const undoBuilder = () => {
        if (undoStack.length > 0) {
            const table = document.getElementById('builder-table');
            redoStack.push(table.innerHTML);
            table.innerHTML = undoStack.pop();
            attachTableFormatListeners();
            rebindAllColumnListeners();
        }
    };

    const redoBuilder = () => {
        if (redoStack.length > 0) {
            const table = document.getElementById('builder-table');
            undoStack.push(table.innerHTML);
            table.innerHTML = redoStack.pop();
            attachTableFormatListeners();
            rebindAllColumnListeners();
        }
    };

    const resolveInstitutionName = (conf = {}) => String(conf.appName || conf.institutionName || conf.institution || conf.schoolName || conf.school || conf.name || '').trim();

    const applyOfficialBranding = (conf = {}) => {
      institutionConfig = conf || {};
      const institutionName = resolveInstitutionName(conf) || 'Official Portal';
      const effectiveLogo = rememberInstitutionLogo(conf.logoUrl || '') || 'assets/images/logo.png';
      ['header-logo', 'official-login-modal-logo'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.src = effectiveLogo;
        el.onerror = () => { el.onerror = null; el.src = 'assets/images/logo.png'; };
      });
      document.getElementById('header-title').textContent = institutionName;
    };

    const hashCredentialValue = async (rawValue = '') => {
      const value = String(rawValue || '');
      if (!value) return '';
      if (!(window.crypto?.subtle)) return value;
      const encoded = new TextEncoder().encode(value);
      const digest = await window.crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };

    const showMsg = (m = '') => { document.getElementById('official-login-msg').textContent = m; };
    const toLabel = (key = '') => String(key || '').replace(/([A-Z])/g, ' $1').replace(/[_.-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
    const normalizeText = (value = '') => String(value || '').trim().toLowerCase();
    const formatDate = (value = '') => {
      if (!value) return '--';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-GB');
    };
    const valueToDisplay = (value) => {
      if (value === undefined || value === null || value === '') return '';
      if (Array.isArray(value)) return value.map(valueToDisplay).join(', ');
      if (typeof value === 'object') {
        if (value.seconds) return formatDate(value.seconds * 1000);
        return Object.entries(value).filter(([, nested]) => nested !== undefined && nested !== null && String(nested).trim() !== '').map(([key, nested]) => `${toLabel(key)}: ${valueToDisplay(nested)}`).join(' • ') || '';
      }
      return String(value);
    };
    const SENSITIVE_PROFILE_KEYS = new Set(['id', 'password', 'passwordhash', 'password_hash', 'username', 'user_name', 'usernameraw', 'username_raw', 'authmeta', 'source', 'email']);
    const isSensitiveProfileField = (key = '', label = '') => {
      const parts = [key, label].map((item) => String(item || '').toLowerCase().replace(/[\s.-]+/g, '_'));
      return parts.some((part) => SENSITIVE_PROFILE_KEYS.has(part) || /(^|_)pass(word)?($|_)/.test(part) || /(^|_)user(name)?($|_)/.test(part) || part.includes('credential') || part.includes('auth'));
    };
    const renderEntriesGrid = (entries = []) => {
      const visibleEntries = entries.filter((entry) => entry && !isSensitiveProfileField(entry.key, entry.label) && valueToDisplay(entry.value) !== '');
      if (!visibleEntries.length) return '<div class="text-sm text-slate-500">No details available.</div>';
      return `<div class="details-grid">${visibleEntries.map((entry) => `<div class="detail-item"><div class="detail-label">${escapeHtml(entry.label || toLabel(entry.key))}</div><div class="detail-value">${escapeHtml(valueToDisplay(entry.value))}</div></div>`).join('')}</div>`;
    };
    const getVisibleEntries = (obj = {}, skipKeys = []) => Object.entries(obj || {}).filter(([k, v]) => !skipKeys.includes(k) && v !== undefined && v !== null && String(valueToDisplay(v)).trim() !== '');
    const renderKeyValueGrid = (obj = {}, skipKeys = []) => renderEntriesGrid(getVisibleEntries(obj, skipKeys).map(([key, value]) => ({ key, label: toLabel(key), value })));
    const getPhoto = (obj = {}) => {
        const rawPhoto = obj.photo || obj.image || obj.logo || '';
        return (rawPhoto && rawPhoto.startsWith('data:')) ? rawPhoto : (sanitizeUrl(rawPhoto) || 'assets/images/logo.png');
    };
    const getStudentClass = (student = {}) => String(student.class || '--').trim() || '--';
    const getStudentGender = (student = {}) => String(student.gender || '').trim();
    const getStudentStatus = (student = {}) => student.isActive === false || student.status === 'inactive' || student.left === true ? 'Inactive' : 'Active';
    const hasStudentConcession = (student = {}) => student.concessionFee !== undefined && student.concessionFee !== null && student.concessionFee !== '';
    const getStudentGroup = (studentId = '') => studentGroups.find((group) => Array.isArray(group.memberIds) && group.memberIds.includes(studentId));
    const getGroupMemberRows = (group = {}) => (group.memberIds || []).map((memberId) => allStudents.find((student) => student.id === memberId)).filter(Boolean);

    const getMobileToggle = () => document.getElementById('mobile-menu-btn');
    const getNavMenu = () => document.querySelector('.nav-menu');
    const setMobileMenuState = (isOpen) => {
      const menu = getNavMenu();
      const toggle = getMobileToggle();
      menu?.classList.toggle('active', isOpen);
      toggle?.classList.toggle('active-toggle', isOpen);
      toggle?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    const isWorksheetPage = window.location.pathname.toLowerCase().includes('worksheet') || document.body.dataset.pageType === 'worksheet';

    const setTab = (tab = 'dashboard') => {
      if (!isWorksheetPage && tab !== 'dashboard') {
        window.location.href = `worksheet.html#${tab}`;
        return;
      }
      if (isWorksheetPage && tab === 'dashboard') {
        window.location.href = 'official.html';
        return;
      }

      const defaultTab = isWorksheetPage ? 'students' : 'dashboard';
      const requested = document.getElementById(`official-tab-${tab}`) ? tab : defaultTab;
      const target = document.getElementById(`official-tab-${requested}`) ? requested : defaultTab;
      document.querySelectorAll('.official-tab').forEach((el) => el.classList.add('hidden'));
      
      const targetEl = document.getElementById(`official-tab-${target}`);
      if(targetEl) {
          targetEl.classList.remove('hidden');
          if (target === 'export') {
              targetEl.classList.add('flex'); 
          } else {
              document.getElementById('official-tab-export')?.classList.remove('flex');
          }
      }

      document.querySelectorAll('.tab-link').forEach((btn) => {
        const active = btn.dataset.tab === target;
        btn.classList.toggle('active', active);
        btn.classList.toggle('text-indigo-700', active);
      });
      setMobileMenuState(false);
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      
      if (target === 'export') {
          renderExportTab();
          setupExcelEngine();
      }
    };

    const openOfficialDetailModal = (title = 'Details', bodyHtml = '') => {
      const titleEl = document.getElementById('official-detail-title');
      const bodyEl = document.getElementById('official-detail-body');
      const modal = document.getElementById('official-detail-modal');
      if (!titleEl || !bodyEl || !modal) return;
      titleEl.textContent = title;
      bodyEl.innerHTML = bodyHtml;
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('overflow-hidden');
    };
    const closeOfficialDetailModal = () => {
      const modal = document.getElementById('official-detail-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('overflow-hidden');
    };

    const closeIdCardModal = () => {
      const modal = document.getElementById('official-id-card-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('overflow-hidden');
    };

    const openIdCardModal = (cardHtml = '') => {
      const contentEl = document.getElementById('official-id-card-content');
      const modal = document.getElementById('official-id-card-modal');
      if (!contentEl || !modal) {
        openOfficialDetailModal('Staff ID Card', cardHtml);
        return;
      }
      contentEl.innerHTML = cardHtml;
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('overflow-hidden');
    };

    document.getElementById('official-detail-close')?.addEventListener('click', closeOfficialDetailModal);
    document.getElementById('official-detail-modal')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeOfficialDetailModal(); });
    document.getElementById('official-id-card-close')?.addEventListener('click', closeIdCardModal);
    document.getElementById('official-id-card-modal')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeIdCardModal(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeOfficialDetailModal();
        closeIdCardModal();
      }
    });

    document.querySelectorAll('.tab-link').forEach((btn) => btn.addEventListener('click', (event) => { event.preventDefault(); setTab(btn.dataset.tab); }));
    document.getElementById('mobile-menu-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = getNavMenu();
      setMobileMenuState(!menu?.classList.contains('active'));
    });
    document.addEventListener('click', (e) => {
      const menu = getNavMenu();
      const toggle = getMobileToggle();
      if (!menu?.contains(e.target) && !toggle?.contains(e.target)) {
        setMobileMenuState(false);
      }
    });

    const summaryStats = () => {
      const totalStudents = allStudents.length;
      const boys = allStudents.filter((student) => normalizeText(student.gender) === 'male').length;
      const girls = allStudents.filter((student) => normalizeText(student.gender) === 'female').length;
      const classCount = new Set(allStudents.map(getStudentClass)).size;
      const teachers = allStaff.filter((staff) => staff.isActive !== false && staff.type === 'Teacher').length;
      const management = allStaff.filter((staff) => staff.isActive !== false && staff.type === 'Management').length;
      const activeStaff = allStaff.filter((staff) => staff.isActive !== false).length;
      const categoryMembers = directoryEntries.length;
      const groupCount = studentGroups.length;
      const concessionStudents = allStudents.filter(hasStudentConcession).length;
      return { totalStudents, boys, girls, classCount, teachers, management, activeStaff, categoryMembers, groupCount, concessionStudents };
    };

    const metricCard = (label, value, tone = 'blue', icon = 'fa-circle-info') => `
      <div class="official-metric-card ${tone}">
        <div><div class="official-metric-label">${escapeHtml(label)}</div><div class="official-metric-value">${escapeHtml(String(value))}</div></div>
        <i class="fas ${icon}"></i>
      </div>`;

    const evaluateModulePermissions = () => {
      const role = window.AppSession?.getRole?.() || '';
      const isAdmin = role === 'admin' || userSession?.source === 'firebase' || userSession?.source === 'legacy-admin' || userSession?.type === 'Admin';
      
      let canCollection = false;
      let canResult = false;
      let canWorksheet = false;
      let canAdmin = false;

      if (isAdmin) {
        canCollection = true;
        canResult = true;
        canWorksheet = true;
        canAdmin = true;
      } else if (userSession?.source === 'staff' || role === 'staff') {
        const staffProfile = getCurrentSessionProfile() || {};
        const staffAccess = window.AppSession?.getStaffAccess?.() || {};
        canCollection = staffAccess.collection === true || (staffProfile.canCollect !== false && staffProfile.canCollect !== undefined);
        canResult = staffAccess.result === true || staffProfile.canManageResults === true;
        canWorksheet = true;
        canAdmin = false;
      } else if (userSession?.source === 'directory') {
        const entry = directoryEntries.find((item) => item.id === userSession.id);
        const access = getPageAccessItem(entry?.categoryId || userSession.categoryId, entry?.id || userSession.id);
        const authItem = getCategoryAuthItem(entry?.categoryId || userSession.categoryId);
        if (!access.blocked) {
          canCollection = Boolean(access.collection || (authItem.enabled && authItem.targetPage === 'collection'));
          canResult = Boolean(access.result);
          canWorksheet = true;
          canAdmin = false;
        }
      } else {
        canWorksheet = true;
      }

      return {
        collection: canCollection,
        result: canResult,
        worksheet: canWorksheet,
        admin: canAdmin
      };
    };

    const renderDashboard = () => {
      const stats = summaryStats();
      const perms = evaluateModulePermissions();
      const role = window.AppSession?.getRole?.() || '';
      const isAdmin = perms.admin;
      const userName = userSession?.name || (isAdmin ? 'Administrator' : 'Staff Member');
      const userRoleLabel = isAdmin ? 'Super Administrator' : (userSession?.type || (role === 'staff' ? 'Staff Member' : 'Official'));

      const modules = [
        {
          id: 'collection',
          title: 'Fee Collection',
          desc: 'Student fee receipts, monthly dues, concessions & billing ledger.',
          icon: 'fa-hand-holding-dollar',
          iconBg: 'bg-emerald-50 text-emerald-600 border border-emerald-200',
          hoverBorder: 'hover:border-emerald-300',
          badgeText: 'Finance & Billing',
          hasAccess: perms.collection,
          href: 'collection.html'
        },
        {
          id: 'result',
          title: 'Result System',
          desc: 'Academic examinations, mark entry compilation & published report cards.',
          icon: 'fa-square-poll-vertical',
          iconBg: 'bg-blue-50 text-blue-600 border border-blue-200',
          hoverBorder: 'hover:border-blue-300',
          badgeText: 'Examinations',
          hasAccess: perms.result,
          href: 'result.html'
        },
        {
          id: 'worksheet',
          title: 'Worksheet Portal',
          desc: 'Class student registers, academic summaries, staff directory & Excel sheet.',
          icon: 'fa-file-excel',
          iconBg: 'bg-teal-50 text-teal-600 border border-teal-200',
          hoverBorder: 'hover:border-teal-300',
          badgeText: 'Registers & Sheets',
          hasAccess: perms.worksheet,
          href: 'worksheet.html',
          isInternalTab: false
        },
        {
          id: 'admin',
          title: 'Admin Panel',
          desc: 'Master control center, academic years, classes, staff & security.',
          icon: 'fa-sliders',
          iconBg: 'bg-indigo-50 text-indigo-600 border border-indigo-200',
          hoverBorder: 'hover:border-indigo-300',
          badgeText: 'System Master',
          hasAccess: perms.admin,
          href: 'admin.html'
        }
      ];

      const moduleCardsHtml = modules.map((m) => {
        if (m.hasAccess) {
          const clickAction = `data-navigate-url="${m.href}"`;
          return `
            <div ${clickAction} class="relative bg-white border border-slate-200 hover:border-blue-400 rounded-2xl p-6 shadow-sm hover:shadow-xl transition-all duration-200 flex flex-col justify-between group cursor-pointer hover:-translate-y-1">
              <div>
                <div class="flex items-center justify-between gap-2 mb-4">
                  <div class="w-14 h-14 rounded-2xl ${m.iconBg} flex items-center justify-center text-2xl shadow-xs group-hover:scale-105 transition-transform">
                    <i class="fas ${m.icon}"></i>
                  </div>
                  <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    Available
                  </span>
                </div>
                <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">${m.badgeText}</div>
                <h4 class="text-xl font-extrabold text-slate-900 group-hover:text-blue-600 transition-colors">${m.title}</h4>
                <p class="text-xs font-medium text-slate-500 mt-2 leading-relaxed">${m.desc}</p>
              </div>
              <div class="pt-5 mt-5 border-t border-slate-100 flex items-center justify-between">
                <span class="text-xs font-semibold text-slate-400 flex items-center gap-1"><i class="fas fa-check-circle text-emerald-500"></i> Authorized Access</span>
                <span class="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-white bg-slate-900 group-hover:bg-blue-600 transition-all shadow-xs">
                  <span>Open Portal</span>
                  <i class="fas fa-arrow-right text-[10px]"></i>
                </span>
              </div>
            </div>`;
        } else {
          return `
            <div data-locked-reason="${m.title}" class="relative bg-slate-50/80 border border-slate-200/80 rounded-2xl p-6 shadow-none opacity-80 flex flex-col justify-between cursor-not-allowed">
              <div>
                <div class="flex items-center justify-between gap-2 mb-4">
                  <div class="w-14 h-14 rounded-2xl bg-slate-200/80 text-slate-400 flex items-center justify-center text-2xl">
                    <i class="fas ${m.icon}"></i>
                  </div>
                  <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-slate-200 text-slate-600 border border-slate-300">
                    <i class="fas fa-lock text-[10px]"></i>
                    No Access
                  </span>
                </div>
                <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">${m.badgeText}</div>
                <h4 class="text-xl font-extrabold text-slate-700">${m.title}</h4>
                <p class="text-xs font-medium text-slate-500 mt-2 leading-relaxed">${m.desc}</p>
              </div>
              <div class="pt-5 mt-5 border-t border-slate-200/70 flex items-center justify-between">
                <span class="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                  <i class="fas fa-shield-halved text-slate-400"></i> Restricted
                </span>
                <span class="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold text-slate-500 bg-slate-200/80">
                  <i class="fas fa-lock text-[10px]"></i>
                  <span>Locked</span>
                </span>
              </div>
            </div>`;
        }
      }).join('');

      const dashContainer = document.getElementById('official-tab-dashboard');
      if (!dashContainer) return;

      dashContainer.innerHTML = `
        <div class="max-w-4xl mx-auto py-4 sm:py-6 space-y-6">
          <!-- Hub Welcome Banner -->
          <div class="bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 text-white rounded-3xl p-6 sm:p-8 shadow-lg border border-slate-800 relative overflow-hidden">
            <div class="absolute -right-10 -bottom-10 w-60 h-60 bg-blue-500/10 rounded-full blur-3xl pointer-events-none"></div>
            <div class="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold bg-white/10 text-white/90 border border-white/15 backdrop-blur-sm mb-2">
                  <i class="fas fa-shield-alt text-emerald-400"></i>
                  <span>${escapeHtml(resolveInstitutionName(institutionConfig) || 'Institution')} Official Hub</span>
                </div>
                <h3 class="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">Welcome, ${escapeHtml(userName)}</h3>
                <p class="text-xs sm:text-sm text-slate-300 font-medium mt-1">Logged in as <b class="text-white">${escapeHtml(userRoleLabel)}</b>. Choose an access portal below to continue.</p>
              </div>
            </div>
          </div>

          <!-- Section: The 4 Portal Access Buttons -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
            ${moduleCardsHtml}
          </div>
        </div>`;

      // Event bindings
      document.querySelectorAll('[data-open-tab]').forEach((btn) => {
        btn.addEventListener('click', () => setTab(btn.dataset.openTab));
      });
      document.querySelectorAll('[data-navigate-url]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const url = btn.dataset.navigateUrl;
          if (url) window.location.href = url;
        });
      });
      document.querySelectorAll('[data-locked-reason]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const modTitle = btn.dataset.lockedReason || 'This module';
          openOfficialDetailModal(
            'Access Restricted',
            `<div class="text-center py-6 px-4">
              <div class="w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 mx-auto flex items-center justify-center text-2xl mb-4 border border-slate-200">
                <i class="fas fa-lock"></i>
              </div>
              <h3 class="text-lg font-extrabold text-slate-900 mb-1">${escapeHtml(modTitle)} is Locked</h3>
              <p class="text-sm text-slate-600 max-w-sm mx-auto leading-relaxed">Your current staff account has not been granted permissions for this department.</p>
              <div class="mt-4 p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-500 font-medium max-w-sm mx-auto text-left">
                <b class="text-slate-700">Need Access?</b> Please contact the institution administrator to enable this permission on your staff account profile.
              </div>
              <div class="mt-6 flex justify-center">
                <button type="button" onclick="document.getElementById('official-detail-close')?.click()" class="px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 transition-all">
                  Understood
                </button>
              </div>
            </div>`
          );
        });
      });
      document.getElementById('hub-quick-logout')?.addEventListener('click', () => {
        localStorage.removeItem(OFFICIAL_SESSION_KEY);
        window.AppSession?.clearAll?.();
        window.location.href = 'index.html';
      });
    };

    const buildStudentDetailHtml = (student = {}) => {
      const group = getStudentGroup(student.id);
      const photoUrl = getPhoto(student);
      const status = getStudentStatus(student);

      const knownKeys = ['id', 'photo', 'image', 'photoUrl', 'photo_url', 'avatar', 'class', 'uid', 'name', 'father', 'mother', 'gender', 'adm', 'dob', 'adm_date', 'admDate', 'status', 'adhaar', 'aadhaar', 'aadhar', 'mobile', 'phone', 'fatherMobile', 'motherMobile', 'mother_mobile', 'address', 'concessionFee', 'busStop', 'busFee', 'route', 'remarks'];
      const extraFields = Object.entries(student || {}).filter(([k, v]) => !knownKeys.includes(k) && v !== null && v !== undefined && String(v).trim() !== '');

      const fatherPhone = student.mobile || student.phone || student.fatherMobile || '';
      const motherPhone = student.motherMobile || student.mother_mobile || '';
      const uidVal = student.uid || student.id || '--';
      const admDateVal = student.adm_date || student.admDate || '--';
      const adhaarVal = student.adhaar || student.aadhaar || student.aadhar || '--';

      return `
        <div class="space-y-4">
          <!-- Header Banner with Student Avatar -->
          <div class="flex flex-col sm:flex-row items-center sm:items-start gap-4 p-4 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 text-white shadow-md">
            <div class="relative w-20 h-20 rounded-2xl overflow-hidden border-2 border-white/20 bg-slate-800 flex-shrink-0 shadow">
              <img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(student.name || 'Student')}" class="w-full h-full object-cover" onerror="this.onerror=null;this.src='assets/images/logo.png'">
            </div>
            <div class="text-center sm:text-left flex-1 min-w-0">
              <div class="flex flex-wrap items-center justify-center sm:justify-start gap-2 mb-1">
                <h3 class="text-xl font-extrabold text-white truncate">${escapeHtml(student.name || '--')}</h3>
                <span class="px-2.5 py-0.5 rounded-full text-xs font-bold ${status === 'Active' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30' : 'bg-slate-700 text-slate-300'}">${escapeHtml(status)}</span>
              </div>
              <p class="text-xs font-semibold text-indigo-200">
                Class: <b class="text-white">${escapeHtml(student.class || '--')}</b> &nbsp;•&nbsp;
                Adm No: <b class="text-white">${escapeHtml(student.adm || '--')}</b> &nbsp;•&nbsp;
                UID: <b class="text-white">${escapeHtml(uidVal)}</b>
              </p>
            </div>
          </div>

          <!-- 3-Tab Navigator -->
          <div class="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
            <button type="button" class="modal-nav-tab active" data-stu-tab="personal">
              <i class="fas fa-user-circle"></i>
              <span>1. Personal Details (വ്യക്തിവിവരം)</span>
            </button>
            <button type="button" class="modal-nav-tab" data-stu-tab="academic">
              <i class="fas fa-graduation-cap"></i>
              <span>2. Academic Details (അക്കാദമിക്)</span>
            </button>
            <button type="button" class="modal-nav-tab" data-stu-tab="fee">
              <i class="fas fa-receipt"></i>
              <span>3. Fee & Services (ഫീസ് വിവരങ്ങൾ)</span>
            </button>
          </div>

          <!-- Tab Pane 1: Personal (7 core fields) -->
          <div id="stu-tab-pane-personal" class="stu-tab-pane space-y-3">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">4. Full Student Name</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5">${escapeHtml(student.name || '--')}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">7. Gender</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5">${escapeHtml(student.gender || '--')}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">9. Date of Birth (DOB)</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5">${escapeHtml(student.dob || '--')}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">12. Aadhaar Number</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5 font-mono">${escapeHtml(adhaarVal)}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">5. Father's Name</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5">${escapeHtml(student.father || '--')}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">13. Father's Phone Number</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5 flex items-center justify-between">
                  <span class="font-mono">${escapeHtml(fatherPhone || '--')}</span>
                  ${fatherPhone ? `<a href="tel:${escapeHtml(fatherPhone)}" class="text-blue-600 hover:text-blue-800 p-1" title="Call Father"><i class="fas fa-phone-alt text-xs"></i></a>` : ''}
                </div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">6. Mother's Name</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5">${escapeHtml(student.mother || '--')}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">14. Mother's Phone Number</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5 flex items-center justify-between">
                  <span class="font-mono">${escapeHtml(motherPhone || '--')}</span>
                  ${motherPhone ? `<a href="tel:${escapeHtml(motherPhone)}" class="text-blue-600 hover:text-blue-800 p-1" title="Call Mother"><i class="fas fa-phone-alt text-xs"></i></a>` : ''}
                </div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 sm:col-span-2 lg:col-span-3">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">15. Permanent Address</span>
                <div class="font-medium text-slate-900 text-sm mt-0.5 whitespace-pre-line leading-relaxed">${escapeHtml(student.address || '--')}</div>
              </div>
            </div>
          </div>

          <!-- Tab Pane 2: Academic (5 core fields) -->
          <div id="stu-tab-pane-academic" class="stu-tab-pane space-y-3 hidden">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div class="p-3 rounded-xl bg-indigo-50/70 border border-indigo-100">
                <span class="text-[10px] font-bold text-indigo-700 uppercase tracking-wider block">2. Current Class</span>
                <div class="font-extrabold text-indigo-950 text-base mt-0.5">${escapeHtml(student.class || '--')}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">8. Admission Number (Adm. No.)</span>
                <div class="font-extrabold text-slate-900 text-base mt-0.5 font-mono">${escapeHtml(student.adm || '--')}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">3. Unique ID (ID / UID)</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5 font-mono">${escapeHtml(uidVal)}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">10. Date of Admission</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5">${escapeHtml(admDateVal)}</div>
              </div>
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">11. Student Status</span>
                <div class="font-extrabold text-slate-900 text-sm mt-0.5">${escapeHtml(status)}</div>
              </div>
            </div>
          </div>

          <!-- Tab Pane 3: Fee & Services -->
          <div id="stu-tab-pane-fee" class="stu-tab-pane space-y-3 hidden">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div class="p-3.5 rounded-xl border ${hasStudentConcession(student) ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}">
                <span class="text-[10px] font-bold uppercase tracking-wider block ${hasStudentConcession(student) ? 'text-emerald-700' : 'text-slate-500'}">Fee Concession Status</span>
                <div class="font-extrabold text-sm mt-1 ${hasStudentConcession(student) ? 'text-emerald-900' : 'text-slate-800'}">
                  ${hasStudentConcession(student) ? `Concession Granted: ₹${escapeHtml(String(student.concessionFee))}` : 'Standard Fee Structure (No Concession)'}
                </div>
              </div>
              <div class="p-3.5 rounded-xl border ${group ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-slate-50'}">
                <span class="text-[10px] font-bold uppercase tracking-wider block ${group ? 'text-blue-700' : 'text-slate-500'}">Group Concession</span>
                <div class="font-extrabold text-sm mt-1 ${group ? 'text-blue-900' : 'text-slate-800'}">
                  ${group ? `Active in Group (Fee: ₹${escapeHtml(String(group.fee || 0))}/month)` : 'Individual Student Account'}
                </div>
              </div>
              ${(student.busStop || student.busFee || student.route) ? `
              <div class="p-3.5 rounded-xl border border-amber-200 bg-amber-50 sm:col-span-2">
                <span class="text-[10px] font-bold uppercase tracking-wider block text-amber-700">Transport & Bus Details</span>
                <div class="font-bold text-slate-900 text-sm mt-1">
                  Stop: <b>${escapeHtml(student.busStop || '--')}</b> &nbsp;•&nbsp; Bus Fee: <b>₹${escapeHtml(String(student.busFee || 0))}</b> &nbsp;•&nbsp; Route: <b>${escapeHtml(student.route || '--')}</b>
                </div>
              </div>` : ''}
            </div>

            ${group ? `
              <div class="rounded-2xl border border-blue-200 bg-blue-50/70 p-3.5">
                <div class="flex items-center justify-between gap-2 mb-2">
                  <h4 class="font-extrabold text-blue-900 text-sm"><i class="fas fa-users mr-1.5"></i> Linked Group Members</h4>
                  <span class="badge">₹${escapeHtml(String(group.fee || 0))}/month</span>
                </div>
                <div class="space-y-1.5">${getGroupMemberRows(group).map((member, index) => `
                  <div class="flex items-center justify-between rounded-xl bg-white border border-blue-100 px-3 py-2 text-xs">
                    <span class="font-bold ${member.id === student.id ? 'text-blue-700' : 'text-slate-800'}">${index + 1}. ${escapeHtml(member.name || '--')}</span>
                    <span class="text-slate-500 font-semibold">Class ${escapeHtml(member.class || '--')}</span>
                  </div>`).join('')}
                </div>
              </div>` : ''}

            ${extraFields.length ? `
              <div class="rounded-2xl border border-slate-200 p-3 bg-white">
                <h4 class="text-xs font-bold text-slate-600 mb-2 uppercase tracking-wider">Additional Attributes</h4>
                <div class="grid grid-cols-2 gap-2 text-xs">
                  ${extraFields.map(([k, v]) => `
                    <div class="p-2 rounded-xl bg-slate-50 border border-slate-100">
                      <span class="text-slate-400 font-bold block text-[10px] uppercase">${escapeHtml(toLabel(k))}</span>
                      <span class="font-semibold text-slate-800">${escapeHtml(valueToDisplay(v))}</span>
                    </div>
                  `).join('')}
                </div>
              </div>` : ''}
          </div>
        </div>`;
    };

    const attachStudentModalTabs = () => {
      document.querySelectorAll('#official-detail-body [data-stu-tab]').forEach((tabBtn) => {
        tabBtn.addEventListener('click', () => {
          const target = tabBtn.dataset.stuTab;
          document.querySelectorAll('#official-detail-body [data-stu-tab]').forEach((b) => b.classList.remove('active'));
          tabBtn.classList.add('active');
          document.querySelectorAll('#official-detail-body .stu-tab-pane').forEach((pane) => pane.classList.add('hidden'));
          document.getElementById(`stu-tab-pane-${target}`)?.classList.remove('hidden');
        });
      });
    };

    const renderStudents = () => {
      const classOptions = [...new Set(allStudents.map(getStudentClass))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const hasSelectedClass = Boolean(officialFilters.studentClass);
      const filteredStudents = hasSelectedClass ? allStudents
        .filter((student) => {
          const cls = getStudentClass(student);
          const gender = normalizeText(student.gender);
          const searchable = Object.values(student || {}).map(valueToDisplay).join(' ').toLowerCase();
          const group = getStudentGroup(student.id);
          const classOk = cls === officialFilters.studentClass;
          const genderOk = officialFilters.studentGender === 'ALL' || gender === normalizeText(officialFilters.studentGender);
          const searchOk = !officialFilters.studentSearch || searchable.includes(officialFilters.studentSearch.toLowerCase());
          const infoOk = officialFilters.studentInfo === 'ALL'
            || (officialFilters.studentInfo === 'GROUPED' && Boolean(group))
            || (officialFilters.studentInfo === 'CONCESSION' && hasStudentConcession(student))
            || (officialFilters.studentInfo === 'MISSING_MOBILE' && !student.mobile)
            || (officialFilters.studentInfo === 'MISSING_UID' && !student.uid);
          return classOk && genderOk && searchOk && infoOk;
        })
        .sort((a, b) => getStudentClass(a).localeCompare(getStudentClass(b), undefined, { numeric: true }) || String(a.name || '').localeCompare(String(b.name || ''))) : [];
      const emptyStudentMessage = hasSelectedClass ? 'No students found for the selected class and filters' : 'Please select a class to view students';

      const primaryColumns = ['class', 'adm', 'name', 'gender', 'uid', 'father', 'mobile'];
      const hiddenSystemKeys = ['id', 'photo', 'image', 'photoUrl', 'photo_url', 'avatar', 'logo'];
      const extraKeys = [...new Set(filteredStudents.flatMap((student) => Object.keys(student || {})))].filter((key) => !hiddenSystemKeys.includes(key) && !primaryColumns.includes(key));
      const columns = [...primaryColumns, ...extraKeys];
      const headerCells = columns.map((key) => `<th class="border p-2 whitespace-nowrap">${escapeHtml(toLabel(key))}</th>`).join('');
      const rows = filteredStudents.map((student, index) => {
        const group = getStudentGroup(student.id);
        const photoUrl = getPhoto(student);
        return `<tr class="hover:bg-blue-50 cursor-pointer official-student-row transition-colors" data-student-id="${escapeHtml(student.id)}">
          <td class="border p-2 text-center font-semibold text-slate-500">${index + 1}</td>
          <td class="border p-1.5 text-center align-middle">
            <img src="${escapeHtml(photoUrl)}" alt="Avatar" class="student-avatar-thumb mx-auto shadow-xs" onerror="this.onerror=null;this.src='assets/images/logo.png'">
          </td>
          ${columns.map((key) => `<td class="border p-2 align-middle">${escapeHtml(valueToDisplay(student?.[key]))}</td>`).join('')}
          <td class="border p-2 align-middle">${group ? `<span class="badge">Group ₹${escapeHtml(String(group.fee || 0))}</span>` : '-'}</td>
        </tr>`;
      }).join('');

      const cardRows = filteredStudents.map((student) => {
        const photoUrl = getPhoto(student);
        return `
          <button type="button" class="official-student-card flex items-center gap-3 p-3.5 text-left w-full border border-slate-200 bg-white rounded-2xl shadow-xs hover:border-blue-400 hover:shadow-md transition-all mb-2" data-student-id="${escapeHtml(student.id)}">
            <img src="${escapeHtml(photoUrl)}" alt="Avatar" class="w-12 h-12 rounded-xl object-cover border border-slate-200 bg-slate-50 flex-shrink-0" onerror="this.onerror=null;this.src='assets/images/logo.png'">
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-1.5 mb-0.5">
                <span class="font-extrabold text-slate-900 text-sm truncate">${escapeHtml(student.name || '--')}</span>
                <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 whitespace-nowrap">Class ${escapeHtml(student.class || '--')}</span>
              </div>
              <div class="text-xs text-slate-500">Adm: <b class="text-slate-700">${escapeHtml(student.adm || '--')}</b> • ${escapeHtml(student.father ? `Father: ${student.father}` : (student.mobile || 'No contact'))}</div>
            </div>
            <i class="fas fa-chevron-right text-xs text-slate-300 ml-1"></i>
          </button>`;
      }).join('');

      const stuTarget = document.getElementById('official-tab-students');
      if (!stuTarget) return;

      stuTarget.innerHTML = `
        <div class="card p-2 sm:p-4 rounded-2xl shadow-sm w-full">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h3 class="font-extrabold text-lg text-slate-900">Students Register</h3>
              <p class="text-xs text-slate-500 font-semibold">Select class to view student profiles with photo avatars. Click any row or card for full 15-field details.</p>
            </div>
            <span class="text-xs font-bold px-3 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">${hasSelectedClass ? `${filteredStudents.length} records` : 'Class required'}</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
            <select id="official-student-class" class="p-2.5 rounded-lg border bg-white text-sm font-semibold"><option value="">Select Class</option>${classOptions.map((className) => `<option value="${escapeHtml(className)}" ${officialFilters.studentClass === className ? 'selected' : ''}>${escapeHtml(className)}</option>`).join('')}</select>
            <select id="official-student-gender" class="p-2.5 rounded-lg border bg-white text-sm font-semibold"><option value="ALL">All Genders</option><option value="Male" ${officialFilters.studentGender === 'Male' ? 'selected' : ''}>Male</option><option value="Female" ${officialFilters.studentGender === 'Female' ? 'selected' : ''}>Female</option></select>
            <select id="official-student-info" class="p-2.5 rounded-lg border bg-white text-sm font-semibold"><option value="ALL">All Info</option><option value="GROUPED" ${officialFilters.studentInfo === 'GROUPED' ? 'selected' : ''}>Grouped</option><option value="CONCESSION" ${officialFilters.studentInfo === 'CONCESSION' ? 'selected' : ''}>Concession</option><option value="MISSING_MOBILE" ${officialFilters.studentInfo === 'MISSING_MOBILE' ? 'selected' : ''}>Missing Mobile</option><option value="MISSING_UID" ${officialFilters.studentInfo === 'MISSING_UID' ? 'selected' : ''}>Missing UID</option></select>
            <input id="official-student-search" value="${escapeHtml(officialFilters.studentSearch)}" class="p-2.5 rounded-lg border bg-white text-sm font-semibold lg:col-span-2" placeholder="Search name / adm / phone / any detail">
          </div>
          <div class="overflow-auto w-full"><table class="w-full text-xs md:text-sm border-collapse min-w-[1000px]"><thead><tr class="bg-slate-100 text-slate-700"><th class="border p-2 w-10">#</th><th class="border p-2 text-center w-14">Photo</th>${headerCells}<th class="border p-2">Group</th></tr></thead><tbody>${rows || `<tr><td colspan="${columns.length + 3}" class="border p-3 text-center text-slate-500">${emptyStudentMessage}</td></tr>`}</tbody></table></div>
          <div class="official-mobile-card-list mt-4">${cardRows || `<div class="text-sm text-slate-500">${emptyStudentMessage}</div>`}</div>
        </div>`;
      document.getElementById('official-student-class')?.addEventListener('change', (e) => { officialFilters.studentClass = e.target.value; renderStudents(); });
      document.getElementById('official-student-gender')?.addEventListener('change', (e) => { officialFilters.studentGender = e.target.value; renderStudents(); });
      document.getElementById('official-student-info')?.addEventListener('change', (e) => { officialFilters.studentInfo = e.target.value; renderStudents(); });
      document.getElementById('official-student-search')?.addEventListener('input', (e) => { officialFilters.studentSearch = e.target.value; renderStudents(); });
      document.querySelectorAll('[data-student-id]').forEach((el) => el.addEventListener('click', () => {
        const student = allStudents.find((item) => item.id === el.dataset.studentId);
        if (student) {
          openOfficialDetailModal('Student Profile', buildStudentDetailHtml(student));
          attachStudentModalTabs();
        }
      }));
    };

    const buildClassSummary = () => {
      const map = new Map();
      allStudents.forEach((student) => {
        const cls = getStudentClass(student);
        if (!map.has(cls)) map.set(cls, { boys: 0, girls: 0, total: 0, active: 0, inactive: 0, missingMobile: 0, missingUid: 0, grouped: 0, concession: 0 });
        const row = map.get(cls);
        row.total += 1;
        const gender = normalizeText(student.gender);
        if (gender === 'male') row.boys += 1;
        else if (gender === 'female') row.girls += 1;
        if (getStudentStatus(student) === 'Active') row.active += 1;
        else row.inactive += 1;
        if (!student.mobile) row.missingMobile += 1;
        if (!student.uid) row.missingUid += 1;
        if (getStudentGroup(student.id)) row.grouped += 1;
        if (hasStudentConcession(student)) row.concession += 1;
      });
      const keys = [...map.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const totals = { boys: 0, girls: 0, total: 0, active: 0, inactive: 0, missingMobile: 0, missingUid: 0, grouped: 0, concession: 0 };
      const rows = keys.map((cls) => {
        const row = map.get(cls);
        Object.keys(totals).forEach((key) => { totals[key] += row[key]; });
        return `<tr class="hover:bg-indigo-50"><td class="border p-2 font-semibold"><button type="button" class="text-blue-700 font-extrabold class-filter-btn" data-class="${escapeHtml(cls)}">${escapeHtml(cls)}</button></td><td class="border p-2 text-center">${row.boys}</td><td class="border p-2 text-center">${row.girls}</td><td class="border p-2 text-center font-bold">${row.total}</td><td class="border p-2 text-center">${row.active}</td><td class="border p-2 text-center">${row.inactive}</td><td class="border p-2 text-center">${row.grouped}</td><td class="border p-2 text-center">${row.concession}</td><td class="border p-2 text-center">${row.missingMobile}</td><td class="border p-2 text-center">${row.missingUid}</td></tr>`;
      }).join('');
      const summaryTarget = document.getElementById('official-tab-summary');
      if (!summaryTarget) return;

      summaryTarget.innerHTML = `
        <div class="card p-4 rounded-2xl shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-4"><div><h3 class="font-extrabold text-lg">Class-wise Summary</h3><p class="text-xs text-slate-500 font-semibold">Click a class name to open students from that class.</p></div><span class="text-xs font-bold px-3 py-1 rounded-full bg-indigo-50 text-indigo-700">Institution Total: ${totals.total}</span></div>
          <div class="overflow-x-auto"><table class="w-full text-sm border-collapse min-w-[900px]"><thead><tr class="bg-slate-100"><th class="border p-2 text-left">Class</th><th class="border p-2">Boys</th><th class="border p-2">Girls</th><th class="border p-2">Total</th><th class="border p-2">Active</th><th class="border p-2">Inactive</th><th class="border p-2">Grouped</th><th class="border p-2">Concession</th><th class="border p-2">No Mobile</th><th class="border p-2">No UID</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="border p-3 text-center text-slate-500">No students available</td></tr>'}<tr class="bg-indigo-50 font-bold"><td class="border p-2">Grand Total</td><td class="border p-2 text-center">${totals.boys}</td><td class="border p-2 text-center">${totals.girls}</td><td class="border p-2 text-center">${totals.total}</td><td class="border p-2 text-center">${totals.active}</td><td class="border p-2 text-center">${totals.inactive}</td><td class="border p-2 text-center">${totals.grouped}</td><td class="border p-2 text-center">${totals.concession}</td><td class="border p-2 text-center">${totals.missingMobile}</td><td class="border p-2 text-center">${totals.missingUid}</td></tr></tbody></table></div>
        </div>`;
      document.querySelectorAll('.class-filter-btn').forEach((btn) => btn.addEventListener('click', () => {
        officialFilters.studentClass = btn.dataset.class || '';
        renderStudents();
        setTab('students');
      }));
    };

    const normalizeConfiguredFields = (fields = []) => (Array.isArray(fields) ? fields : [])
      .map((field) => ({ ...field, key: String(field.key || ''), label: String(field.label || field.key || ''), order: Number(field.order || 999) }))
      .filter((field) => field.key && !isSensitiveProfileField(field.key, field.label))
      .sort((a, b) => a.order - b.order);
    const getDirectoryCategory = (categoryId = '') => directoryCategories.find((category) => category.id === categoryId);
    const getCategoryAuthItem = (categoryId = '') => {
      const raw = categoryAuthConfig?.categories?.[categoryId] || {};
      return { enabled: raw.enabled === true, targetPage: raw.targetPage === 'student' ? 'student' : 'collection', usernameField: String(raw.usernameField || ''), passwordField: String(raw.passwordField || '') };
    };
    const getPageAccessItem = (categoryId = '', entryId = '') => {
      const categoryAccess = pageAccessConfig?.categories?.[categoryId] || {};
      const override = pageAccessConfig?.overrides?.[entryId] || {};
      if (override.blocked === true) return { collection: false, student: false, blocked: true };
      return { collection: typeof override.collection === 'boolean' ? override.collection : categoryAccess.collection === true, student: typeof override.student === 'boolean' ? override.student : categoryAccess.student === true, blocked: false };
    };
    const buildStaffDetailHtml = (staff = {}) => {
      const photoUrl = getPhoto(staff);
      const isActive = staff.isActive !== false;
      const dutyClasses = Array.isArray(staff.dutyClasses) && staff.dutyClasses.length ? staff.dutyClasses.join(', ') : 'All / Not Assigned';
      const role = staff.role || staff.designation || staff.type || 'Staff Member';

      return `
        <div class="space-y-4">
          <!-- Profile Header Banner -->
          <div class="flex flex-col sm:flex-row items-center sm:items-start gap-4 p-4 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-emerald-950 text-white shadow-md">
            <div class="relative w-20 h-20 rounded-2xl overflow-hidden border-2 border-white/20 bg-slate-800 flex-shrink-0 shadow">
              ${(staff.photo || staff.image) ? `<img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(staff.name || 'Staff')}" class="w-full h-full object-cover" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.classList.remove('hidden');"><div class="hidden w-full h-full bg-slate-800 flex items-center justify-center text-slate-400"><i class="fas fa-user text-2xl"></i></div>` : `<div class="w-full h-full bg-slate-800 flex items-center justify-center text-slate-400"><i class="fas fa-user text-2xl"></i></div>`}
            </div>
            <div class="text-center sm:text-left flex-1 min-w-0">
              <div class="flex flex-wrap items-center justify-center sm:justify-start gap-2 mb-1">
                <h3 class="text-xl font-extrabold text-white truncate">${escapeHtml(staff.name || '--')}</h3>
                <span class="px-2.5 py-0.5 rounded-full text-xs font-bold ${isActive ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30' : 'bg-slate-700 text-slate-300'}">${isActive ? 'Active Staff' : 'Inactive'}</span>
              </div>
              <p class="text-xs font-semibold text-emerald-200">
                Designation: <b class="text-white">${escapeHtml(role)}</b> &nbsp;•&nbsp;
                Type: <b class="text-white">${escapeHtml(staff.type || '--')}</b>
              </p>
            </div>
          </div>

          <!-- Contact & Duty Grid -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
              <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Phone Number</span>
              <div class="font-extrabold text-slate-900 text-sm mt-0.5 flex items-center justify-between">
                <span class="font-mono">${escapeHtml(staff.phone || '--')}</span>
                ${staff.phone ? `<a href="tel:${escapeHtml(staff.phone)}" class="text-emerald-600 hover:text-emerald-800 p-1" title="Call Staff"><i class="fas fa-phone-alt text-xs"></i></a>` : ''}
              </div>
            </div>
            <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
              <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Email Address</span>
              <div class="font-bold text-slate-900 text-sm mt-0.5 truncate">${escapeHtml(staff.email || '--')}</div>
            </div>
            <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
              <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">MSR Identification Number</span>
              <div class="font-extrabold text-slate-900 text-sm mt-0.5 font-mono">${escapeHtml(staff.msr || '--')}</div>
            </div>
            <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
              <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Assigned Duty Classes</span>
              <div class="font-extrabold text-indigo-700 text-sm mt-0.5">${escapeHtml(dutyClasses)}</div>
            </div>
            <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 sm:col-span-2">
              <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Residential Address</span>
              <div class="font-medium text-slate-900 text-sm mt-0.5 whitespace-pre-line leading-relaxed">${escapeHtml(staff.address || '--')}</div>
            </div>
          </div>

          <!-- Module Permissions Matrix -->
          <div class="rounded-2xl border border-slate-200 p-4 bg-white shadow-xs">
            <h4 class="font-extrabold text-xs text-slate-500 uppercase tracking-wider mb-3">System Module Permissions</h4>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div class="p-2.5 rounded-xl border ${staff.canCollect !== false ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-500'} font-bold flex items-center gap-2">
                <i class="fas ${staff.canCollect !== false ? 'fa-check-circle text-emerald-600' : 'fa-times-circle text-slate-400'}"></i>
                <span>Fee Collection</span>
              </div>
              <div class="p-2.5 rounded-xl border ${staff.canManageResults === true ? 'border-blue-200 bg-blue-50 text-blue-800' : 'border-slate-200 bg-slate-50 text-slate-500'} font-bold flex items-center gap-2">
                <i class="fas ${staff.canManageResults === true ? 'fa-check-circle text-blue-600' : 'fa-times-circle text-slate-400'}"></i>
                <span>Result System</span>
              </div>
              <div class="p-2.5 rounded-xl border border-teal-200 bg-teal-50 text-teal-800 font-bold flex items-center gap-2">
                <i class="fas fa-check-circle text-teal-600"></i>
                <span>Worksheet</span>
              </div>
              <div class="p-2.5 rounded-xl border ${staff.type === 'Admin' ? 'border-indigo-200 bg-indigo-50 text-indigo-800' : 'border-slate-200 bg-slate-50 text-slate-500'} font-bold flex items-center gap-2">
                <i class="fas ${staff.type === 'Admin' ? 'fa-check-circle text-indigo-600' : 'fa-times-circle text-slate-400'}"></i>
                <span>Admin Panel</span>
              </div>
            </div>
          </div>
        </div>`;
    };

    const buildDirectoryDetailHtml = (entry = {}, category = getDirectoryCategory(entry.categoryId)) => {
      const photoUrl = getPhoto(entry.values || entry);
      const authItem = getCategoryAuthItem(entry.categoryId);
      const hiddenKeys = new Set([authItem.usernameField, authItem.passwordField].filter(Boolean));
      const visibleFields = normalizeConfiguredFields(category?.fields || []).filter((f) => !hiddenKeys.has(f.key));

      return `
        <div class="space-y-4">
          <div class="flex flex-col sm:flex-row items-center sm:items-start gap-4 p-4 rounded-2xl bg-gradient-to-r from-slate-900 to-indigo-950 text-white shadow-md">
            <div class="relative w-16 h-16 rounded-2xl overflow-hidden border-2 border-white/20 bg-slate-800 flex-shrink-0 shadow">
              <img src="${escapeHtml(photoUrl)}" alt="Member" class="w-full h-full object-cover" onerror="this.onerror=null;this.src='assets/images/logo.png'">
            </div>
            <div>
              <h3 class="text-xl font-extrabold text-white">${escapeHtml(entry.values?.name || entry.values?.title || 'Member Profile')}</h3>
              <p class="text-xs font-semibold text-indigo-200">Category: <b class="text-white">${escapeHtml(category?.name || 'Directory Category')}</b></p>
            </div>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${visibleFields.map((f) => `
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">${escapeHtml(f.label)}</span>
                <div class="font-bold text-slate-900 text-sm mt-0.5">${escapeHtml(valueToDisplay(entry.values?.[f.key]))}</div>
              </div>
            `).join('')}
          </div>
        </div>`;
    };

    const renderStaffTab = () => {
      const filteredStaff = allStaff.filter((staff) => {
        const type = String(staff.type || '--');
        const status = staff.isActive === false ? 'inactive' : 'active';
        const search = Object.values(staff || {}).map(valueToDisplay).join(' ').toLowerCase();
        const typeOk = officialFilters.staffType === 'ALL' || type === officialFilters.staffType;
        const statusOk = officialFilters.staffStatus === 'ALL' || status === officialFilters.staffStatus;
        const searchOk = !officialFilters.staffSearch || search.includes(officialFilters.staffSearch.toLowerCase());
        return typeOk && statusOk && searchOk;
      }).sort((a, b) => Number(a.displayOrder || 999) - Number(b.displayOrder || 999));

      const staffTypes = [...new Set(allStaff.map((staff) => String(staff.type || '--')))].sort((a, b) => a.localeCompare(b));

      const staffCardsHtml = filteredStaff.map((staff) => {
        const photoUrl = getPhoto(staff);
        const isActive = staff.isActive !== false;
        const dutyClasses = Array.isArray(staff.dutyClasses) && staff.dutyClasses.length ? staff.dutyClasses.join(', ') : 'All';
        return `
          <div class="staff-compact-card cursor-pointer group" data-staff-id="${escapeHtml(staff.id)}">
            <div>
              <div class="flex items-start justify-between gap-2 mb-3">
                  ${(staff.photo || staff.image) ? `<img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(staff.name || 'Staff')}" class="w-11 h-11 rounded-xl object-cover border border-slate-200 bg-slate-50 flex-shrink-0 shadow-2xs group-hover:border-blue-400 transition-colors" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.classList.remove('hidden');"><div class="hidden w-11 h-11 rounded-xl border border-slate-200 bg-slate-100 flex items-center justify-center text-slate-300 flex-shrink-0"><i class="fas fa-user text-sm"></i></div>` : `<div class="w-11 h-11 rounded-xl border border-slate-200 bg-slate-100 flex items-center justify-center text-slate-300 flex-shrink-0"><i class="fas fa-user text-sm"></i></div>`}
                  <div class="min-w-0">
                    <h4 class="font-extrabold text-slate-900 text-sm leading-tight truncate group-hover:text-blue-600 transition-colors">${escapeHtml(staff.name || '--')}</h4>
                    <span class="text-[11px] font-semibold text-slate-500">${escapeHtml(staff.role || staff.type || 'Staff')}</span>
                  </div>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'} whitespace-nowrap">
                  ${isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div class="space-y-1.5 my-3 text-xs bg-slate-50/70 p-2.5 rounded-xl border border-slate-100">
                <div class="flex items-center justify-between">
                  <span class="text-slate-400 font-semibold text-[11px]">Phone:</span>
                  <span class="font-bold text-slate-800 font-mono">${escapeHtml(staff.phone || '--')}</span>
                </div>
                <div class="flex items-center justify-between">
                  <span class="text-slate-400 font-semibold text-[11px]">Duty:</span>
                  <span class="font-bold text-indigo-700 truncate max-w-[150px]">${escapeHtml(dutyClasses)}</span>
                </div>
              </div>
            </div>

            <div class="pt-3 border-t border-slate-100 flex items-center justify-between">
              <div class="flex items-center gap-1">
                ${staff.canCollect !== false ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/60" title="Fee Collection Active">Fee</span>` : ''}
                ${staff.canManageResults === true ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200/60" title="Result Entry Active">Result</span>` : ''}
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-teal-50 text-teal-700 border border-teal-200/60" title="Worksheet Active">Sheet</span>
              </div>
              <button type="button" class="text-xs font-bold text-blue-600 group-hover:text-blue-800 flex items-center gap-1">
                <span>View</span>
                <i class="fas fa-chevron-right text-[10px]"></i>
              </button>
            </div>
          </div>`;
      }).join('');

      const catBlocks = directoryCategories.map((cat) => {
        const entries = directoryEntries.filter((entry) => entry.categoryId === cat.id).sort((a, b) => Number(a.displayOrder || 999) - Number(b.displayOrder || 999));
        return `
          <div class="border border-slate-200 rounded-2xl p-4 bg-white shadow-xs">
            <div class="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
              <div>
                <h4 class="font-extrabold text-slate-900 text-sm">${escapeHtml(cat.name || 'Category')}</h4>
                <span class="text-xs text-slate-500 font-semibold">${entries.length} registered members</span>
              </div>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              ${entries.map((entry) => {
                const photoUrl = getPhoto(entry.values || entry);
                return `
                  <div class="staff-compact-card cursor-pointer group" data-dir-id="${escapeHtml(entry.id)}">
                    <div class="flex items-center gap-3">
                      <img src="${escapeHtml(photoUrl)}" alt="Member" class="w-10 h-10 rounded-xl object-cover border border-slate-200 bg-slate-50 flex-shrink-0" onerror="this.onerror=null;this.src='assets/images/logo.png'">
                      <div class="min-w-0 flex-1">
                        <h5 class="font-bold text-slate-900 text-xs truncate group-hover:text-blue-600 transition-colors">${escapeHtml(entry.values?.name || entry.values?.title || 'Member')}</h5>
                        <p class="text-[11px] text-slate-500 truncate">${escapeHtml(entry.values?.phone || entry.values?.mobile || cat.name || '--')}</p>
                      </div>
                    </div>
                  </div>`;
              }).join('') || '<div class="text-xs text-slate-400 p-2">No entries in this category</div>'}
            </div>
          </div>`;
      }).join('');

      const staffTarget = document.getElementById('official-tab-staff');
      if (!staffTarget) return;

      staffTarget.innerHTML = `
        <div class="card p-3 sm:p-5 rounded-2xl shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h3 class="font-extrabold text-lg text-slate-900">Staff & Directory</h3>
              <p class="text-xs text-slate-500 font-semibold">Institutional educators, administration, management and category registers. Click any card for full details.</p>
            </div>
            <span class="text-xs font-bold px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">${filteredStaff.length} Staff Members</span>
          </div>

          <div class="grid sm:grid-cols-3 gap-3 mb-5">
            <select id="official-staff-type" class="p-2.5 rounded-xl border bg-white text-sm font-semibold">
              <option value="ALL">All Staff Types</option>
              ${staffTypes.map((type) => `<option value="${escapeHtml(type)}" ${officialFilters.staffType === type ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}
            </select>
            <select id="official-staff-status" class="p-2.5 rounded-xl border bg-white text-sm font-semibold">
              <option value="ALL">All Status</option>
              <option value="active" ${officialFilters.staffStatus === 'active' ? 'selected' : ''}>Active Only</option>
              <option value="inactive" ${officialFilters.staffStatus === 'inactive' ? 'selected' : ''}>Inactive Only</option>
            </select>
            <input id="official-staff-search" value="${escapeHtml(officialFilters.staffSearch)}" class="p-2.5 rounded-xl border bg-white text-sm font-semibold" placeholder="Search name, role, phone, MSR...">
          </div>

          <!-- Staff Cards Grid -->
          <div class="mb-6">
            <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 px-1">Staff Register (${filteredStaff.length})</h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              ${staffCardsHtml || '<div class="text-sm text-slate-400 p-4 col-span-full text-center">No staff records match the current filters.</div>'}
            </div>
          </div>

          <!-- Directory Categories -->
          ${catBlocks ? `
            <div class="space-y-4 pt-4 border-t border-slate-100">
              <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">Other Directory Categories</h4>
              ${catBlocks}
            </div>` : ''}
        </div>`;

      document.getElementById('official-staff-type')?.addEventListener('change', (e) => { officialFilters.staffType = e.target.value; renderStaffTab(); });
      document.getElementById('official-staff-status')?.addEventListener('change', (e) => { officialFilters.staffStatus = e.target.value; renderStaffTab(); });
      document.getElementById('official-staff-search')?.addEventListener('input', (e) => { officialFilters.staffSearch = e.target.value; renderStaffTab(); });

      document.querySelectorAll('[data-staff-id]').forEach((card) => card.addEventListener('click', () => {
        const staff = allStaff.find((item) => item.id === card.dataset.staffId);
        if (staff) openOfficialDetailModal('Staff Profile', buildStaffDetailHtml(staff));
      }));

      document.querySelectorAll('[data-dir-id]').forEach((card) => card.addEventListener('click', () => {
        const entry = directoryEntries.find((item) => item.id === card.dataset.dirId);
        if (entry) openOfficialDetailModal('Category Member Profile', buildDirectoryDetailHtml(entry));
      }));
    };

    const getCurrentSessionProfile = () => {
      if (userSession?.source === 'staff') {
        return allStaff.find((staff) => staff.id === userSession.id || normalizeText(staff.email) === normalizeText(userSession.username) || normalizeText(staff.name) === normalizeText(userSession.name)) || userSession;
      }
      if (userSession?.source === 'directory') {
        const entry = directoryEntries.find((item) => item.id === userSession.id);
        if (entry) return entry;
      }
      return userSession || {};
    };
    const getAllowedPageLabels = () => {
      const labels = ['Official Portal'];
      if (userSession?.source === 'firebase' || userSession?.source === 'legacy-admin') return [...labels, 'Admin Dashboard', 'Collection Page', 'Student Page', 'Result Management'];
      if (userSession?.source === 'staff') {
        const profile = getCurrentSessionProfile();
        if (profile.canCollect !== false) labels.push('Collection Page');
        if (profile.canManageResults === true) labels.push('Result Management');
        return labels;
      }
      if (userSession?.source === 'directory') {
        const entry = directoryEntries.find((item) => item.id === userSession.id);
        const access = getPageAccessItem(entry?.categoryId || userSession.categoryId, entry?.id || userSession.id);
        const authItem = getCategoryAuthItem(entry?.categoryId || userSession.categoryId);
        if (!access.blocked) {
          if (access.collection || (authItem.enabled && authItem.targetPage === 'collection')) labels.push('Collection Page');
          if (access.student || (authItem.enabled && authItem.targetPage === 'student')) labels.push('Student Page');
        }
        return labels;
      }
      return labels;
    };

    const getStaffProfileEntries = (staff = {}) => [
      { key: 'name', label: 'Name', value: staff.name },
      { key: 'role', label: 'Role / Designation', value: staff.role || staff.designation || staff.type },
      { key: 'type', label: 'Staff Type', value: staff.type },
      { key: 'phone', label: 'Phone', value: staff.phone },
      { key: 'email', label: 'Email', value: staff.email },
      { key: 'msr', label: 'MSR Number', value: staff.msr },
      { key: 'dutyClasses', label: 'Duty Classes', value: Array.isArray(staff.dutyClasses) ? staff.dutyClasses.join(', ') : staff.dutyClasses },
      { key: 'address', label: 'Address', value: staff.address },
      { key: 'status', label: 'Status', value: staff.isActive !== false ? 'Active' : 'Inactive' }
    ];

    const getDirectoryProfileEntries = (entry = {}) => {
      const cat = getDirectoryCategory(entry?.categoryId);
      const fields = normalizeConfiguredFields(cat?.fields || []);
      return fields.map((f) => ({ key: f.key, label: f.label, value: entry?.values?.[f.key] }));
    };

    const openMyProfileModal = () => {
      const profile = getCurrentSessionProfile();
      const isDirectory = userSession?.source === 'directory';
      const label = isDirectory ? (profile.values?.name || userSession?.name || 'Staff Member') : (profile.name || userSession?.name || 'Staff Member');
      const userType = isDirectory ? (getDirectoryCategory(profile.categoryId)?.name || userSession?.type || 'Staff') : (profile.role || profile.designation || profile.type || userSession?.type || 'Staff');

      const rawPhoto = isDirectory ? (profile.values?.photo || profile.values?.image) : (profile.photo || profile.image);
      const hasPhoto = Boolean(rawPhoto && typeof rawPhoto === 'string' && rawPhoto.trim() !== '' && !rawPhoto.includes('assets/images/logo.png'));

      const phone = isDirectory ? (profile.values?.phone || profile.values?.mobile || userSession?.phone || '') : (profile.phone || userSession?.phone || '');
      const email = isDirectory ? (profile.values?.email || userSession?.email || '') : (profile.email || userSession?.email || userSession?.username || '');
      const msr = isDirectory ? (profile.values?.msr || profile.values?.id || '') : (profile.msr || profile.id || '');
      const dutyClasses = isDirectory ? (profile.values?.dutyClasses || '') : (Array.isArray(profile.dutyClasses) ? profile.dutyClasses.join(', ') : (profile.dutyClasses || ''));
      const status = profile.isActive !== false ? 'Active' : 'Inactive';
      const access = getAllowedPageLabels();
      const instName = resolveInstitutionName(institutionConfig) || 'Madrasa / Institution';
      const instReg = institutionConfig?.regNo || institutionConfig?.code || '';

      const photoHtml = hasPhoto
        ? `<div class="relative mx-auto -mt-14 w-28 h-28 rounded-2xl p-1 bg-white shadow-xl border border-slate-200">
             <img src="${escapeHtml(rawPhoto)}" class="w-full h-full rounded-xl object-cover bg-slate-100" alt="${escapeHtml(label)}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-full h-full rounded-xl bg-slate-100 border border-slate-200 flex flex-col items-center justify-center text-slate-300\\'><i class=\\'fas fa-user text-3xl mb-1 text-slate-300\\'></i><span class=\\'text-[9px] font-bold text-slate-400 uppercase\\'>No Photo</span></div>';">
           </div>`
        : `<div class="relative mx-auto -mt-14 w-28 h-28 rounded-2xl p-1 bg-white shadow-xl border border-slate-200">
             <div class="w-full h-full rounded-xl bg-slate-100 border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400">
               <i class="fas fa-user text-3xl text-slate-300 mb-1"></i>
               <span class="text-[9px] font-bold uppercase tracking-wider text-slate-400">No Photo</span>
             </div>
           </div>`;

      const idCardHtml = `
        <div class="w-full bg-white select-none">
          <!-- Top Lanyard Slot Cutout Bar -->
          <div class="bg-slate-900 pt-3 pb-2 px-4 flex justify-center">
            <div class="w-14 h-2.5 rounded-full bg-slate-800 border border-slate-700/80 shadow-inner"></div>
          </div>

          <!-- Institution Header Banner -->
          <div class="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white px-5 pt-3 pb-16 text-center relative">
            <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-widest bg-white/10 text-emerald-300 border border-white/10 mb-1.5">
              <i class="fas fa-id-badge text-emerald-400"></i> Staff Identity Card
            </div>
            <h4 class="text-base font-black tracking-tight text-white uppercase">${escapeHtml(instName)}</h4>
            ${instReg ? `<p class="text-[10px] font-semibold text-slate-400 tracking-wider">Reg No: ${escapeHtml(instReg)}</p>` : ''}
          </div>

          <!-- Photo Container & Body Content -->
          <div class="px-5 pb-5">
            ${photoHtml}

            <!-- Identity Core -->
            <div class="text-center mt-3">
              <h3 class="text-xl font-black text-slate-900 tracking-tight leading-tight">${escapeHtml(label)}</h3>
              <div class="mt-1">
                <span class="inline-block px-3 py-0.5 rounded-full text-xs font-black bg-indigo-50 text-indigo-700 border border-indigo-200">
                  ${escapeHtml(userType)}
                </span>
              </div>
            </div>

            <!-- Details List -->
            <div class="mt-5 space-y-2 text-left bg-slate-50/80 p-3.5 rounded-2xl border border-slate-200/80">
              ${phone ? `
                <div class="flex items-center justify-between gap-2 text-xs">
                  <span class="text-slate-500 font-semibold flex items-center gap-1.5"><i class="fas fa-phone-alt text-slate-400 text-[11px] w-3.5"></i> Phone</span>
                  <span class="font-bold text-slate-800 text-right truncate">${escapeHtml(phone)}</span>
                </div>` : ''}

              ${email ? `
                <div class="flex items-center justify-between gap-2 text-xs">
                  <span class="text-slate-500 font-semibold flex items-center gap-1.5"><i class="fas fa-envelope text-slate-400 text-[11px] w-3.5"></i> Email</span>
                  <span class="font-bold text-slate-800 text-right truncate max-w-[180px]">${escapeHtml(email)}</span>
                </div>` : ''}

              ${msr ? `
                <div class="flex items-center justify-between gap-2 text-xs">
                  <span class="text-slate-500 font-semibold flex items-center gap-1.5"><i class="fas fa-hashtag text-slate-400 text-[11px] w-3.5"></i> ID / MSR</span>
                  <span class="font-bold text-slate-800 text-right">${escapeHtml(msr)}</span>
                </div>` : ''}

              ${dutyClasses ? `
                <div class="flex items-center justify-between gap-2 text-xs">
                  <span class="text-slate-500 font-semibold flex items-center gap-1.5"><i class="fas fa-chalkboard text-slate-400 text-[11px] w-3.5"></i> Classes</span>
                  <span class="font-bold text-slate-800 text-right">${escapeHtml(dutyClasses)}</span>
                </div>` : ''}

              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="text-slate-500 font-semibold flex items-center gap-1.5"><i class="fas fa-circle text-emerald-500 text-[10px] w-3.5"></i> Status</span>
                <span class="font-bold text-emerald-600 uppercase text-[11px]">${escapeHtml(status)}</span>
              </div>
            </div>

            <!-- Department Access Badges -->
            <div class="mt-4 text-center">
              <div class="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 mb-1.5">Authorized Department Access</div>
              <div class="flex flex-wrap gap-1.5 justify-center">
                ${access.map((item) => `
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                    <i class="fas fa-check text-emerald-500 text-[9px]"></i>
                    ${escapeHtml(item)}
                  </span>
                `).join('')}
              </div>
            </div>

            <!-- Card Bottom Bar -->
            <div class="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between text-[9px] text-slate-400 font-bold uppercase tracking-wider">
              <span>Verified ID</span>
              <span>Official Record</span>
            </div>

            <!-- Action Button -->
            <button type="button" id="official-id-card-done-btn" class="mt-4 w-full py-2.5 bg-slate-900 hover:bg-indigo-600 text-white font-bold text-xs rounded-xl shadow-md active:scale-95 transition-all cursor-pointer border-none">
              Close ID Card
            </button>
          </div>
        </div>
      `;

      openIdCardModal(idCardHtml);

      document.getElementById('official-id-card-done-btn')?.addEventListener('click', closeIdCardModal);
    };

    const renderHome = () => {
      const profile = getCurrentSessionProfile();
      const isDirectory = userSession?.source === 'directory';
      const label = isDirectory ? (profile.values?.name || userSession?.name || 'User') : (profile.name || userSession?.name || 'User');
      const photo = isDirectory ? getPhoto(profile.values || {}) : getPhoto(profile || {});
      const userType = isDirectory ? (getDirectoryCategory(profile.categoryId)?.name || userSession?.type || 'Category User') : (profile.type || userSession?.type || '--');
      const entries = isDirectory ? getDirectoryProfileEntries(profile) : (userSession?.source === 'staff' ? getStaffProfileEntries(profile) : renderKeyValueGrid(profile, ['photo', 'image', 'logo']));
      const detailHtml = Array.isArray(entries) ? renderEntriesGrid(entries) : entries;
      const access = getAllowedPageLabels();
      const userLineEl = document.getElementById('official-user-line');
      if (userLineEl) userLineEl.textContent = `${label}`;

      const homeTarget = document.getElementById('official-tab-home');
      if (!homeTarget) return;

      homeTarget.innerHTML = `<div class="official-me-card max-w-5xl mx-auto overflow-hidden rounded-3xl shadow-xl">
          <div class="official-me-hero p-5 sm:p-7 text-white">
            <div class="grid md:grid-cols-[180px_1fr] gap-5 items-center">
              <div class="text-center">
                ${hasPhoto ? `<img src="${escapeHtml(rawPhoto)}" onerror="this.style.display='none'; this.nextElementSibling.classList.remove('hidden');" class="official-me-photo mx-auto" alt="${escapeHtml(label)}"><div class="hidden official-me-photo mx-auto bg-white/20 border border-white/30 flex items-center justify-center text-white/50"><i class="fas fa-user text-5xl"></i></div>` : `<div class="official-me-photo mx-auto bg-white/20 border border-white/30 flex items-center justify-center text-white/50"><i class="fas fa-user text-5xl"></i></div>`}
              </div>
              <div>
                <div class="inline-flex px-3 py-1 rounded-full text-xs font-black bg-white/20 border border-white/25 backdrop-blur">Read-only Official Profile</div>
                <h3 class="text-3xl sm:text-4xl font-black mt-3 leading-tight">${escapeHtml(label)}</h3>
                <p class="text-sm sm:text-base font-bold text-white/85 mt-1">${escapeHtml(userType)}</p>
                <div class="mt-4 flex flex-wrap gap-2">${access.map((item) => `<span class="official-access-pill"><i class="fas fa-check-circle"></i>${escapeHtml(item)}</span>`).join('')}</div>
              </div>
            </div>
          </div>
          <div class="bg-white p-4 sm:p-6">
            <div class="flex items-center gap-2 mb-4"><span class="h-10 w-10 rounded-2xl bg-indigo-50 text-indigo-700 flex items-center justify-center"><i class="fas fa-id-card"></i></span><div><h4 class="font-black text-slate-900">Profile Details</h4><p class="text-xs font-bold text-slate-500">Only admin-entered profile fields are shown. Login credentials are hidden.</p></div></div>
            ${detailHtml}
          </div>
        </div>`;
    };

    const availableDataFields = [
      { id: 'SNO', label: 'Serial No. (Auto)' },
      { id: 'name', label: 'Student Name' },
      { id: 'adm', label: 'Admission No.' },
      { id: 'class', label: 'Class' },
      { id: 'gender', label: 'Gender' },
      { id: 'mobile', label: 'Mobile No.' },
      { id: 'father', label: 'Father Name' },
      { id: 'uid', label: 'UID / Roll No.' },
      { id: 'address', label: 'Address' },
      { id: 'CUSTOM', label: 'Custom/Blank Space' }
    ];

    // Targeted DOM update for columns to preserve user edits
    const populateColumnData = (colIndex) => {
        const colConfig = builderConfig.columns[colIndex];
        const fieldId = colConfig.field;
        
        document.querySelectorAll('#builder-table tr[data-index]').forEach(tr => {
            const studentId = tr.dataset.studentId;
            const rowIndex = parseInt(tr.dataset.index);
            const cell = tr.querySelector(`.builder-cell[data-col="${colIndex}"]`);
            if (!cell) return;
            
            if (fieldId === 'CUSTOM') {
                cell.textContent = '';
            } else if (fieldId === 'SNO') {
                cell.textContent = studentId ? rowIndex + 1 : '';
            } else {
                const student = allStudents.find(s => s.id === studentId);
                cell.textContent = student ? valueToDisplay(student[fieldId]) : '';
            }
        });
    };

    const renderExportTab = () => {
      const classOptions = [...new Set(allStudents.map(getStudentClass))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      let studentRows = builderConfig.classId ? allStudents.filter(s => getStudentClass(s) === builderConfig.classId) : [];
      
      if (builderConfig.sortBy === 'name') {
          studentRows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      } else if (builderConfig.sortBy === 'adm') {
          studentRows.sort((a, b) => String(a.adm || '').localeCompare(String(b.adm || ''), undefined, { numeric: true }));
      }

      const instName = resolveInstitutionName(institutionConfig);
      const instSub = institutionConfig.place || institutionConfig.subtitle || 'Institution Portal';
      const instReg = institutionConfig.regNo ? `Reg No: ${institutionConfig.regNo}` : '';
      
      const colSpanPrint = builderConfig.columns.length; 
      
      const headerHtml = builderConfig.showHeader ? `
        <thead class="${builderConfig.repeatHeader ? 'builder-print-header repeat-header' : 'builder-print-header'}">
           <tr>
             <th colspan="${colSpanPrint + 1}" class="print-header-th bg-white border-0 !p-0">
               <div class="print-header-content">
                  <h1 class="print-inst-name">${escapeHtml(instName)}</h1>
                  <h2 class="print-inst-sub">${escapeHtml(instSub)}</h2>
                  ${instReg ? `<h3 class="print-inst-reg">${escapeHtml(instReg)}</h3>` : ''}
                  ${builderConfig.customTitle ? `<h4 class="print-custom-title">${escapeHtml(builderConfig.customTitle)}</h4>` : ''}
               </div>
             </th>
           </tr>
        </thead>
      ` : '';

      const excelColHeaders = builderConfig.columns.map((col, i) => 
        `<th class="no-print col-header" data-col="${i}" title="Select Column ${String.fromCharCode(65 + i)}">${String.fromCharCode(65 + i)}</th>`
      ).join('');

      const colHeadersHtml = builderConfig.columns.map((col, cIndex) => {
        return `<th class="builder-th group config-row-th" style="width: ${col.width || 'auto'}">
          <div class="col-resizer" data-col-index="${cIndex}"></div>
          <div class="no-print mb-1 flex items-center justify-between gap-1">
            <select class="grid-select builder-col-select" data-col-index="${cIndex}">
              ${availableDataFields.map(f => `<option value="${f.id}" ${f.id === col.field ? 'selected' : ''}>${f.label}</option>`).join('')}
            </select>
            <button class="text-red-500 hover:bg-red-100 px-1 py-0.5 rounded delete-col-btn opacity-0 group-hover:opacity-100 transition-opacity" data-col-index="${cIndex}" title="Remove Column"><i class="fas fa-times"></i></button>
          </div>
          <div class="no-print flex gap-1 items-center">
            <input type="text" class="grid-input builder-col-title-input" value="${escapeHtml(col.title)}" placeholder="Heading..." data-col-index="${cIndex}">
          </div>
          <div class="print-only-heading">${escapeHtml(col.title)}</div>
        </th>`;
      }).join('');

      const renderTbodyRows = (students, startIndex = 0) => {
          const rowCount = Math.max(15, students.length); 
          return Array.from({ length: rowCount }).map((_, rIndex) => {
            const student = students[rIndex] || null;
            return `<tr data-student-id="${student ? escapeHtml(student.id) : ''}" data-index="${startIndex + rIndex}">
              <td class="no-print row-header" data-row="${startIndex + rIndex}">${startIndex + rIndex + 1}</td>
              ${builderConfig.columns.map((col, cIndex) => {
              let cellValue = '';
              if (col.field === 'SNO') cellValue = student ? startIndex + rIndex + 1 : '';
              else if (col.field !== 'CUSTOM' && student) cellValue = valueToDisplay(student[col.field]);
              return `<td class="excel-cell builder-cell" contenteditable="true" data-row="${startIndex + rIndex}" data-col="${cIndex}">${escapeHtml(String(cellValue))}</td>`;
            }).join('')}</tr>`;
          }).join('');
      };

      let bodyHtml = '';
      if (!builderConfig.classId || builderConfig.groupBy === 'mixed') {
          bodyHtml = `<tbody>${renderTbodyRows(studentRows)}</tbody>`;
      } else {
          const boys = studentRows.filter(s => normalizeText(s.gender) === 'male');
          const girls = studentRows.filter(s => normalizeText(s.gender) === 'female');
          
          if (builderConfig.groupBy === 'grouped') {
              bodyHtml = `<tbody>${renderTbodyRows([...boys, ...girls])}</tbody>`;
          } else if (builderConfig.groupBy === 'separate') {
              bodyHtml = `<tbody>${renderTbodyRows(boys)}</tbody>
                          <tbody class="page-break-before">
                            <tr>
                                <td class="no-print row-header">-</td>
                                <td colspan="${builderConfig.columns.length}" class="no-print bg-slate-100 text-center text-xs py-2 text-slate-500 font-bold border-dashed border-y border-slate-300">--- PAGE BREAK (Girls List) ---</td>
                            </tr>
                            ${renderTbodyRows(girls, boys.length)}
                          </tbody>`;
          }
      }

      const ribbonHome = `
        <div id="ribbon-home" class="ribbon-panel ${builderConfig.activeTab === 'home' ? 'active' : ''}">
           <div class="ribbon-group">
               <div class="ribbon-row h-full">
                   <button id="fmt-undo" class="excel-btn-ribbon" title="Undo"><i class="fas fa-undo"></i><span>Undo</span></button>
                   <button id="fmt-redo" class="excel-btn-ribbon" title="Redo"><i class="fas fa-redo"></i><span>Redo</span></button>
               </div>
               <span class="ribbon-label">History</span>
           </div>
           
           <div class="ribbon-group">
               <div class="ribbon-row mb-1">
                   <select class="excel-input-ribbon w-28"><option>Calibri</option><option>Inter</option></select>
                   <div class="flex border border-gray-400 rounded overflow-hidden h-[24px]">
                       <button id="fmt-size-minus" class="px-2 bg-white hover:bg-slate-100 border-r border-gray-400 text-[#323130]"><i class="fas fa-minus text-[10px]"></i></button>
                       <input type="number" id="fmt-size-input" class="w-10 text-center outline-none font-bold text-xs text-[#323130]" value="13" />
                       <button id="fmt-size-plus" class="px-2 bg-white hover:bg-slate-100 border-l border-gray-400 text-[#323130]"><i class="fas fa-plus text-[10px]"></i></button>
                   </div>
               </div>
               <div class="ribbon-row">
                   <button id="fmt-bold" class="excel-btn-small font-serif font-bold text-[14px]">B</button>
                   <button id="fmt-italic" class="excel-btn-small font-serif italic text-[14px]">I</button>
                   <div class="w-px h-4 bg-slate-300 mx-2"></div>
                   <div class="relative flex items-center justify-center excel-btn-small cursor-pointer mr-1" title="Fill Color">
                       <i class="fas fa-fill-drip text-xs"></i>
                       <div class="absolute bottom-0.5 left-1 right-1 h-[3px] bg-white border border-gray-300 pointer-events-none indicator-bg"></div>
                       <input type="color" id="fmt-bg" class="opacity-0 absolute inset-0 cursor-pointer" value="#ffffff">
                   </div>
                   <div class="relative flex items-center justify-center excel-btn-small cursor-pointer" title="Text Color">
                       <i class="fas fa-font text-xs"></i>
                       <div class="absolute bottom-0.5 left-1 right-1 h-[3px] bg-slate-900 pointer-events-none indicator-color"></div>
                       <input type="color" id="fmt-color" class="opacity-0 absolute inset-0 cursor-pointer" value="#0f172a">
                   </div>
               </div>
               <span class="ribbon-label">Font</span>
           </div>
           
           <div class="ribbon-group">
               <div class="ribbon-row h-full">
                   <button id="btn-add-col" class="excel-btn-ribbon text-emerald-700" title="Insert Column"><i class="fas fa-columns"></i><span>Add Col</span></button>
                   <button id="btn-add-row" class="excel-btn-ribbon text-emerald-700" title="Insert Row"><i class="fas fa-table-rows"></i><span>Add Row</span></button>
               </div>
               <span class="ribbon-label">Cells</span>
           </div>
        </div>
      `;

      const ribbonData = `
        <div id="ribbon-data" class="ribbon-panel ${builderConfig.activeTab === 'data' ? 'active' : ''}">
            <div class="ribbon-group">
               <div class="ribbon-row h-full items-center gap-2">
                   <div class="flex flex-col">
                       <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Source Class</label>
                       <select id="builder-class" class="excel-input-ribbon w-32">
                         <option value="">-- Blank Table --</option>
                         ${classOptions.map((className) => `<option value="${escapeHtml(className)}" ${builderConfig.classId === className ? 'selected' : ''}>Class ${escapeHtml(className)}</option>`).join('')}
                       </select>
                   </div>
               </div>
               <span class="ribbon-label">Data Source</span>
            </div>
            <div class="ribbon-group">
               <div class="ribbon-row h-full items-center gap-2">
                   <div class="flex flex-col">
                       <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Sort By</label>
                       <select id="builder-sort" class="excel-input-ribbon w-24">
                          <option value="name" ${builderConfig.sortBy === 'name' ? 'selected' : ''}>Name A-Z</option>
                          <option value="adm" ${builderConfig.sortBy === 'adm' ? 'selected' : ''}>Adm No</option>
                       </select>
                   </div>
                   <div class="flex flex-col">
                       <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Group By</label>
                       <select id="builder-group" class="excel-input-ribbon w-28">
                          <option value="mixed" ${builderConfig.groupBy === 'mixed' ? 'selected' : ''}>Mixed</option>
                          <option value="grouped" ${builderConfig.groupBy === 'grouped' ? 'selected' : ''}>Boys First</option>
                          <option value="separate" ${builderConfig.groupBy === 'separate' ? 'selected' : ''}>Page Break</option>
                       </select>
                   </div>
               </div>
               <span class="ribbon-label">Sort & Filter</span>
            </div>
        </div>
      `;

      const ribbonLayout = `
        <div id="ribbon-layout" class="ribbon-panel ${builderConfig.activeTab === 'layout' ? 'active' : ''}">
            <div class="ribbon-group">
                <div class="ribbon-row h-full gap-2 items-center">
                   <div class="flex flex-col">
                       <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Size</label>
                       <select id="builder-paper" class="excel-input-ribbon w-20">
                          <option value="A4" ${builderConfig.paper === 'A4' ? 'selected' : ''}>A4</option>
                          <option value="Legal" ${builderConfig.paper === 'Legal' ? 'selected' : ''}>Legal</option>
                       </select>
                   </div>
                   <div class="flex flex-col">
                       <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Orientation</label>
                       <select id="builder-orient" class="excel-input-ribbon w-24">
                          <option value="portrait" ${builderConfig.orientation === 'portrait' ? 'selected' : ''}>Portrait</option>
                          <option value="landscape" ${builderConfig.orientation === 'landscape' ? 'selected' : ''}>Landscape</option>
                       </select>
                   </div>
                </div>
                <span class="ribbon-label">Page Setup</span>
            </div>
            <div class="ribbon-group">
                <div class="ribbon-row h-full gap-2 items-center">
                   <div class="flex flex-col">
                       <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Report Title</label>
                       <input type="text" id="builder-custom-title" value="${escapeHtml(builderConfig.customTitle)}" class="excel-input-ribbon w-48" placeholder="e.g. Term 1 Attendance">
                   </div>
                </div>
                <span class="ribbon-label">Titles</span>
            </div>
            <div class="ribbon-group">
                <div class="flex flex-col gap-1 mt-1 justify-center h-full">
                     <label class="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                        <input type="checkbox" id="builder-show-header" ${builderConfig.showHeader ? 'checked' : ''} class="w-3.5 h-3.5 text-emerald-600 rounded"> Show Header
                     </label>
                     <label class="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer ${!builderConfig.showHeader ? 'opacity-50 pointer-events-none' : ''}">
                        <input type="checkbox" id="builder-repeat-header" ${builderConfig.repeatHeader ? 'checked' : ''} class="w-3.5 h-3.5 text-emerald-600 rounded"> Repeat all pages
                     </label>
                </div>
                <span class="ribbon-label">Print Options</span>
            </div>
        </div>
      `;

      const exportTarget = document.getElementById('official-tab-export');
      if (!exportTarget) return;

      exportTarget.innerHTML = `
        <div class="excel-ui-header no-print">
            <div class="excel-tabs">
                <button class="excel-tab ${builderConfig.activeTab === 'home' ? 'active' : ''}" data-ribbon="home">Home</button>
                <button class="excel-tab ${builderConfig.activeTab === 'data' ? 'active' : ''}" data-ribbon="data">Data</button>
                <button class="excel-tab ${builderConfig.activeTab === 'layout' ? 'active' : ''}" data-ribbon="layout">Page Layout</button>
                <div class="flex-grow"></div>
                <div class="flex gap-2 items-center pr-4 mb-1">
                    <button id="btn-export-print" class="premium-export-btn btn-pdf-red"><i class="fas fa-file-pdf"></i> Print / PDF</button>
                    <button id="btn-export-excel" class="premium-export-btn btn-excel-green"><i class="fas fa-file-excel"></i> Export</button>
                </div>
            </div>
            
            <div class="excel-ribbon-container">
                ${ribbonHome}
                ${ribbonData}
                ${ribbonLayout}
            </div>
            
            <div class="formula-bar">
                <div id="active-cell-id" class="formula-name-box">A1</div>
                <div class="formula-divider"></div>
                <div class="formula-icon">fx</div>
                <input type="text" id="formula-input" class="formula-input" placeholder="Select a cell to edit..." />
            </div>
        </div>

        <div class="excel-workspace spreadsheet-container">
          <div id="print-canvas" class="print-canvas" data-paper="${builderConfig.paper}" data-orient="${builderConfig.orientation}">
            <table id="builder-table" class="excel-table">
              ${headerHtml}
              <thead>
                <tr class="no-print">
                   <th class="select-all-corner w-10 border-slate-300" title="Select All"></th>
                   ${excelColHeaders}
                </tr>
                <tr class="config-row">
                   <th class="no-print row-header bg-slate-200 border-slate-300"></th>
                   ${colHeadersHtml}
                </tr>
              </thead>
              ${bodyHtml}
            </table>
          </div>
        </div>
      `;

      attachBuilderListeners();
    };

    const bindColumnListeners = (thElement) => {
        const sel = thElement.querySelector('.builder-col-select');
        sel?.addEventListener('change', (e) => {
            saveBuilderState();
            const idx = parseInt(e.target.dataset.colIndex);
            const fieldId = e.target.value;
            builderConfig.columns[idx].field = fieldId;
            const fieldLabel = availableDataFields.find(f => f.id === fieldId)?.label || 'Column';
            
            const th = e.target.closest('th');
            if(fieldId !== 'CUSTOM') {
                builderConfig.columns[idx].title = fieldLabel;
                builderConfig.columns[idx].width = 'auto';
                th.style.width = 'auto';
                const input = th.querySelector('.builder-col-title-input');
                if(input) input.value = fieldLabel;
                const printHeading = th.querySelector('.print-only-heading');
                if(printHeading) printHeading.textContent = fieldLabel;
            } else {
                builderConfig.columns[idx].width = '150px';
                th.style.width = '150px';
            }
            populateColumnData(idx);
        });

        const titleInput = thElement.querySelector('.builder-col-title-input');
        titleInput?.addEventListener('input', (e) => {
            const idx = parseInt(e.target.dataset.colIndex);
            builderConfig.columns[idx].title = e.target.value;
            const heading = e.target.closest('th').querySelector('.print-only-heading');
            if(heading) heading.textContent = e.target.value;
        });

        const delBtn = thElement.querySelector('.delete-col-btn');
        delBtn?.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.dataset.colIndex);
            if(builderConfig.columns.length > 1) {
                saveBuilderState();
                builderConfig.columns.splice(idx, 1);
                renderExportTab();
                setupExcelEngine();
            } else {
                alert("At least one column is required.");
            }
        });
    };

    const rebindAllColumnListeners = () => {
        document.querySelectorAll('.config-row-th').forEach(th => bindColumnListeners(th));
    };

    const attachBuilderListeners = () => {
      document.querySelectorAll('.excel-tab').forEach(tab => tab.addEventListener('click', (e) => {
          document.querySelectorAll('.excel-tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.ribbon-panel').forEach(p => p.classList.remove('active'));
          e.target.classList.add('active');
          const targetId = e.target.dataset.ribbon;
          builderConfig.activeTab = targetId;
          document.getElementById(`ribbon-${targetId}`).classList.add('active');
      }));

      // Dataset changes require full re-render
      document.getElementById('builder-class')?.addEventListener('change', (e) => { builderConfig.classId = e.target.value; renderExportTab(); setupExcelEngine(); });
      document.getElementById('builder-sort')?.addEventListener('change', (e) => { builderConfig.sortBy = e.target.value; renderExportTab(); setupExcelEngine();});
      document.getElementById('builder-group')?.addEventListener('change', (e) => { builderConfig.groupBy = e.target.value; renderExportTab(); setupExcelEngine();});
      document.getElementById('builder-paper')?.addEventListener('change', (e) => { builderConfig.paper = e.target.value; updateCanvasStyle(); });
      document.getElementById('builder-orient')?.addEventListener('change', (e) => { builderConfig.orientation = e.target.value; updateCanvasStyle(); });
      document.getElementById('builder-show-header')?.addEventListener('change', (e) => { builderConfig.showHeader = e.target.checked; renderExportTab(); setupExcelEngine();});
      document.getElementById('builder-repeat-header')?.addEventListener('change', (e) => { builderConfig.repeatHeader = e.target.checked; renderExportTab(); setupExcelEngine();});
      
      document.getElementById('builder-custom-title')?.addEventListener('input', (e) => { 
          builderConfig.customTitle = e.target.value; 
          const el = document.querySelector('.print-custom-title');
          if(el) el.textContent = e.target.value;
      });

      rebindAllColumnListeners();

      // Targeted DOM update for columns (No full re-render)
      document.getElementById('btn-add-col')?.addEventListener('click', () => {
        saveBuilderState();
        const newColIdx = builderConfig.columns.length;
        const newCol = { id: `col_${Date.now()}`, field: 'CUSTOM', title: 'New Column', width: '150px' };
        builderConfig.columns.push(newCol);

        const printHeaderTh = document.querySelector('.print-header-th');
        if (printHeaderTh) printHeaderTh.colSpan = builderConfig.columns.length + 1;
        
        document.querySelectorAll('.page-break-before td[colspan]').forEach(td => td.colSpan = builderConfig.columns.length + 1);

        const excelHeaderRow = document.querySelector('#builder-table thead tr:first-child');
        const newExcelTh = document.createElement('th');
        newExcelTh.className = "no-print col-header";
        newExcelTh.dataset.col = newColIdx;
        newExcelTh.title = `Select Column ${String.fromCharCode(65 + newColIdx)}`;
        newExcelTh.textContent = String.fromCharCode(65 + newColIdx);
        excelHeaderRow.appendChild(newExcelTh);

        const configRow = document.querySelector('#builder-table thead tr.config-row');
        const newConfigTh = document.createElement('th');
        newConfigTh.className = "builder-th group config-row-th";
        newConfigTh.style.width = newCol.width;
        newConfigTh.innerHTML = `
          <div class="col-resizer" data-col-index="${newColIdx}"></div>
          <div class="no-print mb-1 flex items-center justify-between gap-1">
            <select class="grid-select builder-col-select" data-col-index="${newColIdx}">
              ${availableDataFields.map(f => `<option value="${f.id}" ${f.id === newCol.field ? 'selected' : ''}>${f.label}</option>`).join('')}
            </select>
            <button class="text-red-500 hover:bg-red-100 px-1 py-0.5 rounded delete-col-btn opacity-0 group-hover:opacity-100 transition-opacity" data-col-index="${newColIdx}" title="Remove Column"><i class="fas fa-times"></i></button>
          </div>
          <div class="no-print flex gap-1 items-center">
            <input type="text" class="grid-input builder-col-title-input" value="${escapeHtml(newCol.title)}" placeholder="Heading..." data-col-index="${newColIdx}">
          </div>
          <div class="print-only-heading">${escapeHtml(newCol.title)}</div>
        `;
        configRow.appendChild(newConfigTh);

        document.querySelectorAll('#builder-table tr[data-index]').forEach(tr => {
            const rIndex = tr.dataset.index;
            const td = document.createElement('td');
            td.className = "excel-cell builder-cell";
            td.contentEditable = "true";
            td.dataset.row = rIndex;
            td.dataset.col = newColIdx;
            tr.appendChild(td);
        });

        bindColumnListeners(newConfigTh);
        attachTableFormatListeners();
      });

      document.getElementById('btn-add-row')?.addEventListener('click', () => {
        saveBuilderState();
        const tbodys = document.querySelectorAll('#builder-table tbody');
        if(tbodys.length === 0) return;
        const targetTbody = tbodys[tbodys.length - 1]; 
        const colsCount = builderConfig.columns.length;
        const tr = document.createElement('tr');
        const nextRowIdx = document.querySelectorAll('.row-header').length;
        tr.dataset.index = nextRowIdx;
        tr.dataset.studentId = ""; 
        tr.innerHTML = `<td class="no-print row-header" data-row="${nextRowIdx}">${nextRowIdx + 1}</td>` + 
                       Array.from({ length: colsCount }).map((_, cIndex) => `<td class="excel-cell builder-cell" contenteditable="true" data-row="${nextRowIdx}" data-col="${cIndex}"></td>`).join('');
        targetTbody.appendChild(tr);
        attachTableFormatListeners();
      });

      const applyFormat = (styleProp, valueFn) => {
          saveBuilderState();
          document.querySelectorAll('.builder-cell.selected').forEach(td => {
              td.style[styleProp] = typeof valueFn === 'function' ? valueFn(td.style[styleProp]) : valueFn;
          });
      };
      
      const getActiveFontSize = () => parseInt(document.getElementById('fmt-size-input').value) || 13;
      const toggleStyle = (prop, val1, val2) => (currentVal) => currentVal === val1 ? val2 : val1;

      document.getElementById('fmt-bold')?.addEventListener('click', () => applyFormat('fontWeight', toggleStyle('fontWeight', 'bold', 'normal')));
      document.getElementById('fmt-italic')?.addEventListener('click', () => applyFormat('fontStyle', toggleStyle('fontStyle', 'italic', 'normal')));
      
      document.getElementById('fmt-color')?.addEventListener('input', (e) => {
          const indicator = e.target.parentElement.querySelector('.indicator-color');
          if(indicator) indicator.style.backgroundColor = e.target.value;
          applyFormat('color', e.target.value);
      });
      document.getElementById('fmt-bg')?.addEventListener('input', (e) => {
          const indicator = e.target.parentElement.querySelector('.indicator-bg');
          if(indicator) indicator.style.backgroundColor = e.target.value;
          applyFormat('backgroundColor', e.target.value);
      });
      
      document.getElementById('fmt-size-plus')?.addEventListener('click', () => {
          let size = getActiveFontSize() + 1;
          document.getElementById('fmt-size-input').value = size;
          applyFormat('fontSize', size + 'px');
      });
      document.getElementById('fmt-size-minus')?.addEventListener('click', () => {
          let size = Math.max(8, getActiveFontSize() - 1);
          document.getElementById('fmt-size-input').value = size;
          applyFormat('fontSize', size + 'px');
      });
      document.getElementById('fmt-size-input')?.addEventListener('change', (e) => {
          applyFormat('fontSize', e.target.value + 'px');
      });

      document.getElementById('fmt-undo')?.addEventListener('click', undoBuilder);
      document.getElementById('fmt-redo')?.addEventListener('click', redoBuilder);

      document.getElementById('btn-export-print')?.addEventListener('click', () => {
        document.querySelectorAll('.builder-cell, .col-header, .row-header, .select-all-corner').forEach(c => c.classList.remove('selected'));
        document.body.classList.add('is-printing');
        window.print();
        setTimeout(() => document.body.classList.remove('is-printing'), 500);
      });

      document.getElementById('btn-export-excel')?.addEventListener('click', () => {
        if(typeof XLSX === 'undefined') { alert("Excel library loading, please try again."); return; }
        const tableClone = document.getElementById('builder-table').cloneNode(true);
        tableClone.querySelectorAll('.no-print').forEach(el => el.remove());
        tableClone.querySelectorAll('th').forEach(th => {
           const heading = th.querySelector('.print-only-heading');
           if(heading) th.textContent = heading.textContent;
        });
        const wb = XLSX.utils.table_to_book(tableClone, {sheet: "Report"});
        XLSX.writeFile(wb, `${builderConfig.classId ? 'Class_'+builderConfig.classId : 'Report'}_${formatDate(new Date())}.xlsx`);
      });
    };

    const updateCanvasStyle = () => {
      const canvas = document.getElementById('print-canvas');
      if(canvas) {
        canvas.dataset.paper = builderConfig.paper;
        canvas.dataset.orient = builderConfig.orientation;
      }
    };

    const attachTableFormatListeners = () => {
        const fInput = document.getElementById('formula-input');
        if(!fInput) return;
        document.querySelectorAll('.builder-cell').forEach(cell => {
            // Remove old listener to avoid duplicates if re-attaching
            const newCell = cell.cloneNode(true);
            cell.parentNode.replaceChild(newCell, cell);
            
            newCell.addEventListener('focus', (e) => {
                const row = e.target.dataset.row;
                const col = e.target.dataset.col;
                const colLetter = String.fromCharCode(65 + parseInt(col));
                document.getElementById('active-cell-id').textContent = `${colLetter}${parseInt(row)+1}`;
                fInput.value = e.target.innerText;
            });
            newCell.addEventListener('input', (e) => {
                if(e.target.classList.contains('selected')) fInput.value = e.target.innerText;
            });
        });
        
        // Ensure formula input only has one listener
        const newFInput = fInput.cloneNode(true);
        fInput.parentNode.replaceChild(newFInput, fInput);
        newFInput.addEventListener('input', (e) => {
            const activeCell = document.querySelector('.builder-cell.selected');
            if(activeCell) activeCell.innerText = e.target.value;
        });
    };

    const setupExcelEngine = () => {
        const table = document.getElementById('builder-table');
        if (!table) return;

        attachTableFormatListeners();

        let resizingCol = null;
        let startX = 0;
        let startWidth = 0;

        document.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('col-resizer')) {
                saveBuilderState();
                resizingCol = e.target.closest('th');
                startX = e.pageX;
                startWidth = resizingCol.offsetWidth;
                e.preventDefault();
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (resizingCol) {
                const newWidth = startWidth + (e.pageX - startX);
                if (newWidth > 30) {
                    resizingCol.style.width = newWidth + 'px';
                    const colIndex = resizingCol.querySelector('.col-resizer').dataset.colIndex;
                    if(builderConfig.columns[colIndex]) {
                        builderConfig.columns[colIndex].width = newWidth + 'px';
                    }
                }
            }
        });

        document.addEventListener('mouseup', () => { resizingCol = null; });

        let isSelecting = false;
        let startCell = null;

        const getCellCoords = (td) => {
            return { row: parseInt(td.dataset.row), col: parseInt(td.dataset.col) };
        };

        const clearSelection = () => document.querySelectorAll('.builder-cell, .col-header, .row-header, .select-all-corner').forEach(c => c.classList.remove('selected'));

        table.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('col-resizer')) return; 
            
            const colHeader = e.target.closest('th.col-header');
            if (colHeader) {
                clearSelection();
                colHeader.classList.add('selected');
                document.querySelectorAll(`.builder-cell[data-col="${colHeader.dataset.col}"]`).forEach(c => c.classList.add('selected'));
                return;
            }
            
            const rowHeader = e.target.closest('td.row-header');
            if (rowHeader) {
                clearSelection();
                rowHeader.classList.add('selected');
                document.querySelectorAll(`.builder-cell[data-row="${rowHeader.dataset.row}"]`).forEach(c => c.classList.add('selected'));
                return;
            }
            
            const selectAll = e.target.closest('.select-all-corner');
            if (selectAll) {
                clearSelection();
                selectAll.classList.add('selected');
                document.querySelectorAll('.builder-cell, .col-header, .row-header').forEach(c => c.classList.add('selected'));
                return;
            }

            const td = e.target.closest('td.builder-cell');
            if (td) {
                isSelecting = true;
                startCell = getCellCoords(td);
                clearSelection();
                td.classList.add('selected');
            }
        });

        table.addEventListener('mouseover', (e) => {
            if (isSelecting) {
                const td = e.target.closest('td.builder-cell');
                if (td) {
                    const endCell = getCellCoords(td);
                    const minR = Math.min(startCell.row, endCell.row);
                    const maxR = Math.max(startCell.row, endCell.row);
                    const minC = Math.min(startCell.col, endCell.col);
                    const maxC = Math.max(startCell.col, endCell.col);
                    
                    document.querySelectorAll('.builder-cell').forEach(cell => {
                        const r = parseInt(cell.dataset.row);
                        const c = parseInt(cell.dataset.col);
                        if (r >= minR && r <= maxR && c >= minC && c <= maxC) {
                            cell.classList.add('selected');
                        } else {
                            cell.classList.remove('selected');
                        }
                    });
                }
            }
        });

        document.addEventListener('mouseup', () => isSelecting = false);
        
        table.addEventListener('focusin', (e) => {
            if(e.target.classList.contains('builder-cell')) e.target.dataset.original = e.target.innerHTML;
        });
        table.addEventListener('focusout', (e) => {
            if(e.target.classList.contains('builder-cell')) {
                if(e.target.dataset.original !== e.target.innerHTML) saveBuilderState();
            }
        });

        document.addEventListener('copy', (e) => {
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
            if (builderConfig.activeTab !== 'home' && builderConfig.activeTab !== 'data' && builderConfig.activeTab !== 'layout') return;
            const selected = document.querySelectorAll('.builder-cell.selected');
            if (selected.length === 0) return;

            const rowMap = new Map();
            selected.forEach(td => {
                const tr = td.parentElement;
                if(!rowMap.has(tr)) rowMap.set(tr, []);
                rowMap.get(tr).push(td.innerText.trim());
            });

            const tsv = Array.from(rowMap.values()).map(row => row.join('\t')).join('\n');
            e.clipboardData.setData('text/plain', tsv);
            e.preventDefault();
        });

        document.addEventListener('paste', (e) => {
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
            if (builderConfig.activeTab !== 'home' && builderConfig.activeTab !== 'data' && builderConfig.activeTab !== 'layout') return;
            
            const activeCell = document.querySelector('.builder-cell.selected') || document.activeElement.closest('td.builder-cell');
            if (activeCell) {
                saveBuilderState();
                e.preventDefault();
                const text = e.clipboardData.getData('text/plain');
                const rowsData = text.split(/\r?\n/).map(r => r.split('\t'));
                
                const startR = parseInt(activeCell.dataset.row);
                const startC = parseInt(activeCell.dataset.col);
                
                rowsData.forEach((rowData, i) => {
                    let tr = document.querySelector(`.builder-cell[data-row="${startR + i}"]`)?.parentElement;
                    if (!tr) {
                        const targetTbody = document.querySelector('#builder-table tbody:last-child');
                        if(targetTbody) {
                            tr = document.createElement('tr');
                            const nextRowIdx = startR + i;
                            tr.dataset.index = nextRowIdx;
                            tr.dataset.studentId = ""; 
                            tr.innerHTML = `<td class="no-print row-header" data-row="${nextRowIdx}">${nextRowIdx + 1}</td>` + 
                                           Array.from({ length: builderConfig.columns.length }).map((_, cIndex) => `<td class="excel-cell builder-cell" contenteditable="true" data-row="${nextRowIdx}" data-col="${cIndex}"></td>`).join('');
                            targetTbody.appendChild(tr);
                            attachTableFormatListeners();
                        }
                    }
                    
                    if(tr) {
                        rowData.forEach((val, j) => {
                            const td = tr.querySelector(`.builder-cell[data-col="${startC + j}"]`);
                            if (td) td.textContent = val;
                        });
                    }
                });
            }
        });
    };

    const renderAll = () => {
      renderDashboard();
      renderStudents();
      buildClassSummary();
      renderStaffTab();
      if(document.getElementById('official-tab-export')?.classList.contains('flex')) {
          renderExportTab();
          setupExcelEngine();
      }
      renderHome();
    };

    const loadData = async () => {
      const [studentsSnap, staffSnap, groupsSnap, dirSnap, contentSnap, configSnap, authConfigSnap, pageAccessSnap] = await Promise.all([
        getDocs(collection(db, `${BASE_PATH}/students`)),
        getDocs(collection(db, `${BASE_PATH}/staff`)),
        getDocs(collection(db, `${BASE_PATH}/studentGroups`)),
        getDocs(collection(db, `${BASE_PATH}/publicDirectory`)),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'content')),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'config')),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'categoryAuthConfig')),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'pageAccess'))
      ]);
      allStudents = studentsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      allStaff = staffSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      studentGroups = groupsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      directoryEntries = dirSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      const content = contentSnap.exists() ? contentSnap.data() : {};
      directoryCategories = Array.isArray(content.directoryCategories) ? content.directoryCategories : [];
      categoryAuthConfig = authConfigSnap.exists() ? { categories: {}, ...(authConfigSnap.data() || {}) } : { categories: {} };
      pageAccessConfig = pageAccessSnap.exists() ? { categories: {}, overrides: {}, ...(pageAccessSnap.data() || {}) } : { categories: {}, overrides: {} };
      const conf = configSnap.exists() ? configSnap.data() : {};
      applyOfficialBranding(conf);
    };

    const preloadOfficialBranding = async () => {
      try {
        const configSnap = await getDoc(doc(db, `${BASE_PATH}/settings`, 'config'));
        if (!configSnap.exists()) return;
        applyOfficialBranding(configSnap.data() || {});
      } catch (_error) {}
    };

    const showApp = () => {
      document.getElementById('official-login-screen')?.classList.add('hidden');
      document.getElementById('official-app')?.classList.remove('hidden');

      const role = window.AppSession?.getRole?.() || '';
      const isAdmin = role === 'admin' || userSession?.source === 'firebase' || userSession?.source === 'legacy-admin' || userSession?.type === 'Admin';
      const userName = userSession?.name || (isAdmin ? 'Administrator' : 'Staff Member');
      const userRole = isAdmin ? 'Super Admin' : (userSession?.type || 'Staff');

      const userLineEl = document.getElementById('official-user-line');
      if (userLineEl) userLineEl.textContent = `${userName} (${userRole})`;

      const staffNameDisplay = document.getElementById('staff-name-display');
      if (staffNameDisplay) staffNameDisplay.textContent = userName;
      const staffRoleDisplay = document.getElementById('staff-role-display');
      if (staffRoleDisplay) staffRoleDisplay.textContent = userRole;

      renderAll();
      if (isWorksheetPage) {
        const rawHash = (window.location.hash || '').replace('#', '');
        const validTabs = ['students', 'summary', 'staff', 'export', 'home'];
        setTab(validTabs.includes(rawHash) ? rawHash : 'students');
      } else {
        setTab('dashboard');
        document.getElementById('official-my-profile-btn')?.addEventListener('click', () => {
          openMyProfileModal();
        });
      }
    };

    onAuthStateChanged(auth, async (user) => {
      if (!user) await signInAnonymously(auth);
      authReady = true;
    });

    document.querySelectorAll('#official-logout-btn, .official-logout-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        localStorage.removeItem(OFFICIAL_SESSION_KEY);
        window.AppSession?.clearAll?.();
        window.location.href = 'index.html';
      });
    });

    const restoreOfficialSession = async () => {
      try {
        if (window.AppSession && window.AppSession.isFresh()) {
          const role = window.AppSession.getRole();
          if (role === 'admin' || role === 'staff') {
            const stateKey = role === 'admin' ? 'app_session_admin_state' : 'app_session_staff_state';
            const rawState = localStorage.getItem(stateKey);
            const state = rawState ? JSON.parse(rawState) : {};
            
            userSession = {
              name: state.name || (role === 'admin' ? 'Super Admin' : 'Staff'),
              username: state.email || (role === 'admin' ? 'admin' : (state.userKey || 'staff')),
              type: role === 'admin' ? 'Admin' : 'Staff',
              source: role === 'admin' ? 'firebase' : (state.access?.source || 'staff'),
              access: state.access || null
            };
            await loadData();
            showApp();
            return; 
          }
        }
        // Direct link access without valid session from index.html must return to index.html
        window.location.replace('index.html');
      } catch (_error) {
        window.location.replace('index.html');
      }
    };

    preloadOfficialBranding();
    restoreOfficialSession();
