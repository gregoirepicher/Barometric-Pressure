/* ==========================================================================
   Symptom log — daily migraine / body-pain tracking
   --------------------------------------------------------------------------
   Storage is a single localStorage record. Entries are keyed by LOCAL date
   ("YYYY-MM-DD") so a timezone shift can never move an entry to another day.
   The schema is versioned: adding a sixth question later means old entries
   simply carry `null` for it, never a fabricated zero.
   ========================================================================== */

(function () {
    'use strict';

    // --- Config -----------------------------------------------------------

    // How many days back from today can still be created/edited.
    // 1 = today and yesterday. Raise this if backfilling after a bad stretch
    // becomes necessary — nothing else needs to change.
    const EDITABLE_DAYS_BACK = 1;

    const STORE_KEY = 'bp_symptom_log_v1';
    const TAB_KEY = 'bp_active_tab';
    const SCHEMA_VERSION = 1;

    // Word labels for each point on the 1-10 scale (index 0 === score 1).
    const PAIN_WORDS = ['None', 'Very mild', 'Mild', 'Noticeable', 'Moderate',
        'Strong', 'Severe', 'Very severe', 'Extreme', 'Worst imaginable'];
    const ABILITY_WORDS = ['None', 'Very poor', 'Poor', 'Limited', 'Fair',
        'Moderate', 'Good', 'Very good', 'Near normal', 'Full / normal'];
    const DAY_WORDS = ['Terrible', 'Very bad', 'Bad', 'Poor', 'Mixed',
        'OK', 'Good', 'Very good', 'Great', 'Excellent'];

    // `polarity` says which end of the scale is the good end, which drives
    // both the colour and how the calendar reads at a glance.
    //   'bad'  -> 10 is the worst outcome (pain)
    //   'good' -> 10 is the best outcome (ability, overall day)
    const QUESTIONS = [
        { key: 'headPain', label: 'How would you rate your head pain?', short: 'Head', polarity: 'bad', low: 'None', high: 'Worst', words: PAIN_WORDS },
        { key: 'bodyPain', label: 'How would you rate your body pain?', short: 'Body', polarity: 'bad', low: 'None', high: 'Worst', words: PAIN_WORDS },
        { key: 'cognitive', label: 'How would you rate your cognitive ability?', short: 'Mind', polarity: 'good', low: 'Unable', high: 'Full', words: ABILITY_WORDS },
        { key: 'ambulatory', label: 'How would you rate your ambulatory ability?', short: 'Moving', polarity: 'good', low: 'Unable', high: 'Full', words: ABILITY_WORDS },
        { key: 'overall', label: 'How would you rate the day overall?', short: 'Overall', polarity: 'good', low: 'Terrible', high: 'Excellent', words: DAY_WORDS },
    ];

    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    // --- Date helpers -----------------------------------------------------

    function dateKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    // Parse as LOCAL midnight. `new Date("2026-08-06")` would parse as UTC and
    // land on the previous day for anyone west of Greenwich.
    function parseKey(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function startOfToday() {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    }

    function addDays(d, n) {
        const out = new Date(d);
        out.setDate(out.getDate() + n);
        return out;
    }

    function daysAgo(key) {
        return Math.round((startOfToday() - parseKey(key)) / 86400000);
    }

    function isEditable(key) {
        const ago = daysAgo(key);
        return ago >= 0 && ago <= EDITABLE_DAYS_BACK;
    }

    function isFuture(key) {
        return daysAgo(key) < 0;
    }

    function relativeDayName(key) {
        const ago = daysAgo(key);
        if (ago === 0) return 'Today';
        if (ago === 1) return 'Yesterday';
        if (ago === -1) return 'Tomorrow';
        return null;
    }

    function longDate(d) {
        return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    }

    // --- Colour -----------------------------------------------------------

    // Map a 1-10 score to a hue, 0 (red) through 140 (green), respecting
    // which end of that particular scale is the good end.
    function scoreHue(v, polarity) {
        const good = polarity === 'good' ? (v - 1) / 9 : (10 - v) / 9;
        return Math.round(good * 140);
    }

    function scoreFill(v, polarity, alpha) {
        return `hsla(${scoreHue(v, polarity)}, 68%, 45%, ${alpha})`;
    }

    function scoreText(v, polarity) {
        return `hsl(${scoreHue(v, polarity)}, 72%, 62%)`;
    }

    // --- Store ------------------------------------------------------------

    const Store = {
        _data: null,

        _blank() {
            return { version: SCHEMA_VERSION, entries: {}, lastBackupAt: null };
        },

        load() {
            if (this._data) return this._data;
            try {
                const raw = localStorage.getItem(STORE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object' && parsed.entries) {
                        this._data = {
                            version: parsed.version || 1,
                            entries: parsed.entries,
                            lastBackupAt: parsed.lastBackupAt || null,
                        };
                        return this._data;
                    }
                }
            } catch (e) {
                console.warn('Could not read symptom log:', e);
            }
            this._data = this._blank();
            return this._data;
        },

        persist() {
            try {
                const payload = this.load();
                payload.updatedAt = new Date().toISOString();
                localStorage.setItem(STORE_KEY, JSON.stringify(payload));
                return true;
            } catch (e) {
                console.error('Could not save symptom log:', e);
                alert('Could not save — your device storage may be full.');
                return false;
            }
        },

        get(key) {
            return this.load().entries[key] || null;
        },

        set(key, scores, notes) {
            const data = this.load();
            const existing = data.entries[key];
            const now = new Date().toISOString();

            const entry = {
                date: key,
                createdAt: existing ? existing.createdAt : now,
                updatedAt: now,
            };
            QUESTIONS.forEach(q => {
                entry[q.key] = (typeof scores[q.key] === 'number') ? scores[q.key] : null;
            });
            entry.notes = notes || '';

            // Stamp the pressure for that date. Open-Meteo only serves a rolling
            // window, so if this isn't captured now it can't be recovered later —
            // and it's what makes the pressure/symptom correlation possible.
            const pressure = readPressureForDate(key);
            if (pressure) {
                entry.pressure = pressure;
            } else if (existing && existing.pressure) {
                entry.pressure = existing.pressure;
            }

            data.entries[key] = entry;
            return this.persist() ? entry : null;
        },

        remove(key) {
            const data = this.load();
            delete data.entries[key];
            return this.persist();
        },

        count() {
            return Object.keys(this.load().entries).length;
        },

        markBackedUp() {
            this.load().lastBackupAt = new Date().toISOString();
            this.persist();
        },

        lastBackup() {
            const v = this.load().lastBackupAt;
            return v ? new Date(v) : null;
        },
    };

    // Ask the pressure view for that day's summary. Returns null if the chart
    // data hasn't loaded yet or the date is outside the fetched window —
    // a missing stamp is fine, a wrong one would not be.
    function readPressureForDate(key) {
        try {
            if (typeof window.getPressureSummaryForDate !== 'function') return null;
            return window.getPressureSummaryForDate(key);
        } catch (e) {
            return null;
        }
    }

    // --- Backup / export / import ----------------------------------------

    const BACKUP_NUDGE_DAYS = 14;
    const BACKUP_KIND = 'bp-symptom-log';

    function sortedEntries() {
        const entries = Store.load().entries;
        return Object.keys(entries).sort().map(k => entries[k]);
    }

    // The restorable format. `kind` and `schema` let the importer reject a
    // file that isn't one of ours instead of silently mangling the log.
    function backupPayload() {
        const data = Store.load();
        return {
            kind: BACKUP_KIND,
            schema: data.version || SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            entryCount: Object.keys(data.entries).length,
            entries: data.entries,
        };
    }

    function backupFilename(ext) {
        return `symptom-log-${dateKey(new Date())}.${ext}`;
    }

    function csvCell(v) {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    // Byte-order mark, spelled as an escape so it stays visible in source.
    const BOM = '\uFEFF';

    function snakeCase(s) {
        return s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
    }

    function countOf(n, one, many) {
        return `${n} ${n === 1 ? one : many}`;
    }

    function buildCsv() {
        // Columns are derived from QUESTIONS, so a sixth question later flows
        // through to the export without a second edit.
        const head = ['date']
            .concat(QUESTIONS.map(q => snakeCase(q.key)))
            .concat(['notes', 'pressure_mean', 'pressure_min', 'pressure_max',
                'pressure_range', 'pressure_max_drop_3h', 'pressure_city',
                'created_at', 'updated_at']);

        const rows = sortedEntries().map(e => {
            const p = e.pressure || {};
            return [e.date]
                .concat(QUESTIONS.map(q => e[q.key]))
                .concat([e.notes, p.mean, p.min, p.max, p.range, p.maxDrop3h,
                    p.city, e.createdAt, e.updatedAt])
                .map(csvCell).join(',');
        });

        // Leading BOM so Excel reads accented characters in notes correctly.
        return BOM + [head.join(',')].concat(rows).join('\r\n');
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function exportJson() {
        if (!requireEntries()) return;
        const blob = new Blob([JSON.stringify(backupPayload(), null, 2)],
            { type: 'application/json' });
        downloadBlob(blob, backupFilename('json'));
        Store.markBackedUp();
        updateBackupUi();
    }

    function exportCsv() {
        if (!requireEntries()) return;
        const blob = new Blob([buildCsv()], { type: 'text/csv;charset=utf-8' });
        downloadBlob(blob, backupFilename('csv'));
        // CSV is a read-only view for a clinician — it can't be restored from,
        // so it deliberately does not count as a backup.
    }

    function requireEntries() {
        if (Store.count() === 0) {
            alert('There are no logs to export yet.');
            return false;
        }
        return true;
    }

    // Hand a real file to the OS share sheet so it can be emailed or messaged
    // as an attachment. mailto: can't carry attachments, so this is the only
    // route that gets a restorable file off the phone in one tap.
    async function shareBackup() {
        if (!requireEntries()) return;

        const json = JSON.stringify(backupPayload(), null, 2);
        const filename = backupFilename('json');

        try {
            if (navigator.canShare && typeof File === 'function') {
                const file = new File([json], filename, { type: 'application/json' });
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file], title: 'Symptom log backup' });
                    Store.markBackedUp();
                    updateBackupUi();
                    return;
                }
            }
        } catch (err) {
            // A cancelled share sheet is a normal outcome, not a failure —
            // and it must not be recorded as a completed backup.
            if (err && err.name === 'AbortError') return;
            console.warn('Share failed, falling back to download:', err);
        }

        downloadBlob(new Blob([json], { type: 'application/json' }), filename);
        Store.markBackedUp();
        updateBackupUi();
    }

    // --- Import -----------------------------------------------------------

    function looksLikeEntry(key, e) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
        if (!e || typeof e !== 'object') return false;
        const hasScore = QUESTIONS.some(q => typeof e[q.key] === 'number');
        return hasScore || typeof e.notes === 'string';
    }

    // Merge, never replace: an older backup must not wipe newer entries made
    // on this device. Per date, the most recently updated version wins.
    function planMerge(incoming) {
        const current = Store.load().entries;
        const plan = { add: [], update: [], keep: [], invalid: 0 };

        Object.keys(incoming).forEach(key => {
            const inc = incoming[key];
            if (!looksLikeEntry(key, inc)) { plan.invalid++; return; }
            const cur = current[key];
            if (!cur) {
                plan.add.push(key);
            } else if (inc.updatedAt && (!cur.updatedAt || inc.updatedAt > cur.updatedAt)) {
                plan.update.push(key);
            } else {
                plan.keep.push(key);
            }
        });
        return plan;
    }

    function applyImport(incoming, plan) {
        const data = Store.load();
        plan.add.concat(plan.update).forEach(key => {
            const e = Object.assign({}, incoming[key]);
            e.date = key;
            data.entries[key] = e;
        });
        return Store.persist();
    }

    function handleImportFile(file) {
        const reader = new FileReader();

        reader.onerror = () => alert('Could not read that file.');
        reader.onload = () => {
            let parsed;
            try {
                parsed = JSON.parse(reader.result);
            } catch (e) {
                alert('That file isn\'t valid JSON, so it can\'t be a symptom log backup.');
                return;
            }

            // Accept a full backup file, or a bare { "YYYY-MM-DD": {...} } map.
            let incoming = null;
            if (parsed && parsed.entries && typeof parsed.entries === 'object') {
                incoming = parsed.entries;
            } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                incoming = parsed;
            }

            if (!incoming || !Object.keys(incoming).length) {
                alert('No symptom entries found in that file.');
                return;
            }

            const plan = planMerge(incoming);

            if (!plan.add.length && !plan.update.length) {
                // Distinguish "nothing new" from "nothing usable" — telling the
                // user their log is already up to date when the file was
                // actually unreadable would hide a real problem.
                alert(plan.keep.length
                    ? `Nothing to restore — ${countOf(plan.keep.length, 'entry', 'entries')} in `
                        + 'that backup ' + (plan.keep.length === 1 ? 'is' : 'are')
                        + ' already on this device (or older than what\'s here).'
                    : 'No readable symptom entries were found in that file.');
                return;
            }

            const lines = [`This backup has ${countOf(Object.keys(incoming).length, 'entry', 'entries')}.`, ''];
            if (plan.add.length) lines.push(`  ${plan.add.length} new, will be added`);
            if (plan.update.length) lines.push(`  ${plan.update.length} newer, will replace what's here`);
            if (plan.keep.length) lines.push(`  ${plan.keep.length} already up to date, left alone`);
            if (plan.invalid) lines.push(`  ${plan.invalid} unreadable, skipped`);
            lines.push('', 'Restore now?');

            if (!confirm(lines.join('\n'))) return;

            if (applyImport(incoming, plan)) {
                renderCalendar();
                updateBackupUi();
                alert(`Restored. ${plan.add.length} added, ${plan.update.length} updated.`);
            }
        };

        reader.readAsText(file);
    }

    // --- Backup UI --------------------------------------------------------

    function describeLastBackup() {
        const last = Store.lastBackup();
        if (!last) return Store.count() ? 'Never backed up' : '';
        const days = Math.floor((Date.now() - last.getTime()) / 86400000);
        if (days === 0) return 'Backed up today';
        if (days === 1) return 'Backed up yesterday';
        if (days < 30) return `Backed up ${days} days ago`;
        return `Backed up ${last.toLocaleDateString()}`;
    }

    function updateBackupUi() {
        el.backupWhen.textContent = describeLastBackup();

        const n = Store.count();
        const last = Store.lastBackup();
        const stale = last
            ? (Date.now() - last.getTime()) > BACKUP_NUDGE_DAYS * 86400000
            : true;

        if (n > 0 && stale) {
            el.backupNudge.innerHTML = last
                ? `<span>It's been over ${BACKUP_NUDGE_DAYS} days since your last backup.</span>`
                    + '<button type="button" class="btn-primary" id="nudgeBackup">Back up</button>'
                : `<span>You have ${n} ${n === 1 ? 'day' : 'days'} logged and no backup yet.</span>`
                    + '<button type="button" class="btn-primary" id="nudgeBackup">Back up</button>';
            el.backupNudge.style.display = 'flex';
        } else {
            el.backupNudge.style.display = 'none';
        }
    }

    // --- View state -------------------------------------------------------

    let calMode = 'month';        // 'month' | 'week'
    let anchor = startOfToday();  // any date inside the displayed period
    let sheetKey = null;          // date key currently open in the sheet
    let draft = {};               // in-progress scores while the sheet is open

    // --- Element refs -----------------------------------------------------

    const el = {};

    function cacheEls() {
        el.tabPressure = document.getElementById('tabPressure');
        el.tabSymptoms = document.getElementById('tabSymptoms');
        el.viewPressure = document.getElementById('pressureView');
        el.viewSymptoms = document.getElementById('symptomsView');
        el.headerSub = document.getElementById('headerSub');

        el.calTitle = document.getElementById('calTitle');
        el.calBody = document.getElementById('calBody');
        el.calPrev = document.getElementById('calPrev');
        el.calNext = document.getElementById('calNext');
        el.calToday = document.getElementById('calToday');
        el.segMonth = document.getElementById('segMonth');
        el.segWeek = document.getElementById('segWeek');
        el.logCount = document.getElementById('logCount');
        el.logTodayBtn = document.getElementById('logTodayBtn');

        el.backupNudge = document.getElementById('backupNudge');
        el.backupWhen = document.getElementById('backupWhen');
        el.shareBackupBtn = document.getElementById('shareBackupBtn');
        el.downloadJsonBtn = document.getElementById('downloadJsonBtn');
        el.downloadCsvBtn = document.getElementById('downloadCsvBtn');
        el.restoreBtn = document.getElementById('restoreBtn');
        el.restoreInput = document.getElementById('restoreInput');

        el.backdrop = document.getElementById('sheetBackdrop');
        el.sheet = document.getElementById('daySheet');
        el.sheetTitle = document.getElementById('sheetTitle');
        el.sheetSub = document.getElementById('sheetSub');
        el.sheetBody = document.getElementById('sheetBody');
        el.sheetActions = document.getElementById('sheetActions');
    }

    // --- Tabs -------------------------------------------------------------

    function showTab(name) {
        const symptoms = name === 'symptoms';
        el.viewPressure.style.display = symptoms ? 'none' : '';
        el.viewSymptoms.style.display = symptoms ? '' : 'none';
        el.tabPressure.classList.toggle('active', !symptoms);
        el.tabSymptoms.classList.toggle('active', symptoms);
        el.headerSub.textContent = symptoms
            ? 'Track daily symptoms alongside the pressure forecast'
            : 'Monitor pressure changes that may trigger migraines';

        try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* ignore */ }

        if (symptoms) {
            renderCalendar();
        } else if (typeof window.onPressureTabShown === 'function') {
            // The chart sizes itself to its container; while hidden that width
            // is 0, so it needs a nudge once it's visible again.
            window.onPressureTabShown();
        }
    }

    // --- Calendar rendering ----------------------------------------------

    function renderCalendar() {
        el.segMonth.classList.toggle('active', calMode === 'month');
        el.segWeek.classList.toggle('active', calMode === 'week');

        const n = Store.count();
        el.logCount.innerHTML = `<strong>${n}</strong> ${n === 1 ? 'day' : 'days'} logged`;
        updateBackupUi();

        if (calMode === 'month') {
            renderMonth();
        } else {
            renderWeek();
        }
    }

    function renderMonth() {
        const year = anchor.getFullYear();
        const month = anchor.getMonth();
        el.calTitle.textContent = `${MONTHS[month]} ${year}`;

        // Start on the Sunday on or before the 1st, and always draw whole weeks
        // so the grid doesn't change height between months.
        const first = new Date(year, month, 1);
        const gridStart = addDays(first, -first.getDay());
        const last = new Date(year, month + 1, 0);
        const totalCells = Math.ceil((last.getDate() + first.getDay()) / 7) * 7;

        let html = '<div class="cal-grid">';
        DOW.forEach(d => { html += `<div class="cal-dow">${d[0]}</div>`; });

        const todayKey = dateKey(startOfToday());

        for (let i = 0; i < totalCells; i++) {
            const d = addDays(gridStart, i);
            const key = dateKey(d);
            const inMonth = d.getMonth() === month;
            const entry = Store.get(key);

            const classes = ['cal-day'];
            if (!inMonth) classes.push('out');
            if (isFuture(key)) classes.push('future');
            if (key === todayKey) classes.push('today');
            if (inMonth && !entry && isEditable(key)) classes.push('can-add');

            let style = '';
            let score = '';
            if (entry && entry.overall !== null && entry.overall !== undefined) {
                style = ` style="background:${scoreFill(entry.overall, 'good', 0.3)};border-color:${scoreFill(entry.overall, 'good', 0.55)}"`;
                score = `<span class="dscore" style="color:${scoreText(entry.overall, 'good')}">${entry.overall}</span>`;
            } else if (entry) {
                // Logged, but the overall question was left unanswered.
                style = ' style="background:rgba(148,163,184,0.14)"';
                score = '<span class="dscore" style="color:#94a3b8">&bull;</span>';
            }

            const clickable = inMonth && !isFuture(key);
            html += `<div class="${classes.join(' ')}"${style}${clickable ? ` data-key="${key}"` : ''}>`
                + `<span class="dnum">${d.getDate()}</span>${score}</div>`;
        }
        html += '</div>';
        html += monthKeyHtml();

        el.calBody.innerHTML = html;
    }

    function monthKeyHtml() {
        let bar = '';
        for (let v = 1; v <= 10; v++) {
            bar += `<span style="background:${scoreFill(v, 'good', 0.75)}"></span>`;
        }
        return `<div class="cal-key"><span>Worse day</span><span class="bar">${bar}</span><span>Better day</span></div>`;
    }

    function renderWeek() {
        // Week runs Sunday -> Saturday, containing `anchor`.
        const start = addDays(anchor, -anchor.getDay());
        const end = addDays(start, 6);

        const sameMonth = start.getMonth() === end.getMonth();
        el.calTitle.textContent = sameMonth
            ? `${MONTHS[start.getMonth()].slice(0, 3)} ${start.getDate()}–${end.getDate()}`
            : `${MONTHS[start.getMonth()].slice(0, 3)} ${start.getDate()} – ${MONTHS[end.getMonth()].slice(0, 3)} ${end.getDate()}`;

        const todayKey = dateKey(startOfToday());
        let html = '<div class="week-list">';

        for (let i = 0; i < 7; i++) {
            const d = addDays(start, i);
            const key = dateKey(d);
            const entry = Store.get(key);
            const future = isFuture(key);

            const classes = ['week-row'];
            if (future) classes.push('future');
            if (key === todayKey) classes.push('today');

            let right;
            if (entry) {
                let minis = '';
                QUESTIONS.forEach(q => {
                    const v = entry[q.key];
                    const shown = (v === null || v === undefined)
                        ? '<span style="color:#475569">–</span>'
                        : `<span style="color:${scoreText(v, q.polarity)}">${v}</span>`;
                    minis += `<div class="mini"><span class="k">${q.short}</span><span class="v">${shown}</span></div>`;
                });
                const note = entry.notes
                    ? `<div class="week-note">${escapeHtml(entry.notes)}</div>`
                    : '';
                right = `<div class="week-scores">${minis}${note}</div>`;
            } else if (future) {
                right = '<div class="week-empty">—</div>';
            } else {
                right = `<div class="week-empty">${isEditable(key) ? 'Tap to add a log' : 'No log recorded'}</div>`;
            }

            const rel = relativeDayName(key);
            html += `<div class="${classes.join(' ')}"${future ? '' : ` data-key="${key}"`}>`
                + `<div class="week-date"><div class="wd">${rel === 'Today' ? 'Today' : DOW[d.getDay()]}</div>`
                + `<div class="dd">${d.getDate()}</div></div>${right}</div>`;
        }
        html += '</div>';
        el.calBody.innerHTML = html;
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // --- Day sheet --------------------------------------------------------

    function openSheet(key) {
        sheetKey = key;
        const entry = Store.get(key);
        const editable = isEditable(key);
        const d = parseKey(key);
        const rel = relativeDayName(key);

        el.sheetTitle.textContent = rel ? `${rel}` : longDate(d);
        el.sheetSub.textContent = rel ? longDate(d) : '';

        draft = {};
        QUESTIONS.forEach(q => {
            draft[q.key] = entry && typeof entry[q.key] === 'number' ? entry[q.key] : null;
        });

        if (editable) {
            renderEditForm(entry);
        } else {
            renderReadOnly(entry, key);
        }

        el.backdrop.classList.add('open');
        el.sheet.classList.add('open');
        el.sheet.scrollTop = 0;
        document.body.style.overflow = 'hidden';
    }

    function closeSheet() {
        el.backdrop.classList.remove('open');
        el.sheet.classList.remove('open');
        document.body.style.overflow = '';
        sheetKey = null;
    }

    function pressureStripHtml(key) {
        const p = (Store.get(key) && Store.get(key).pressure) || readPressureForDate(key);
        if (!p) return '';
        const drop = (p.maxDrop3h && p.maxDrop3h < 0) ? `${p.maxDrop3h.toFixed(1)} hPa` : 'None';
        return '<div class="sheet-pressure">'
            + `<div class="p"><span class="k">Avg pressure</span><span class="v">${p.mean} hPa</span></div>`
            + `<div class="p"><span class="k">Range</span><span class="v">${p.range} hPa</span></div>`
            + `<div class="p"><span class="k">Sharpest 3h drop</span><span class="v">${drop}</span></div>`
            + '</div>';
    }

    function renderEditForm(entry) {
        let html = pressureStripHtml(sheetKey);

        QUESTIONS.forEach(q => {
            const v = draft[q.key];
            html += `<div class="q" data-q="${q.key}">`
                + `<div class="q-label"><span>${q.label}</span>`
                + `<span class="q-answer ${v === null ? 'unset' : ''}" data-answer="${q.key}"`
                + `${v === null ? '' : ` style="color:${scoreText(v, q.polarity)}"`}>`
                + `${v === null ? 'Not answered' : q.words[v - 1]}</span></div>`
                + '<div class="scale">';
            for (let n = 1; n <= 10; n++) {
                const sel = v === n;
                const style = sel ? ` style="background:${scoreFill(n, q.polarity, 0.85)}"` : '';
                html += `<button type="button" class="${sel ? 'sel' : ''}" data-score="${n}"${style}>${n}</button>`;
            }
            html += '</div>'
                + `<div class="scale-ends"><span>1 &middot; ${q.low}</span><span>${q.high} &middot; 10</span></div>`
                + '</div>';
        });

        html += '<div class="q"><label class="notes-label" for="entryNotes">Notes (optional)</label>'
            + `<textarea id="entryNotes" placeholder="Triggers, medication, sleep, anything worth remembering...">${entry ? escapeHtml(entry.notes || '') : ''}</textarea></div>`;

        el.sheetBody.innerHTML = html;

        el.sheetActions.innerHTML =
            (entry ? '<button type="button" class="btn-danger" id="deleteEntry">Delete</button>' : '')
            + '<div class="spacer"></div>'
            + '<button type="button" class="btn-secondary" id="cancelEntry">Cancel</button>'
            + `<button type="button" class="btn-primary" id="saveEntry">${entry ? 'Update' : 'Save'}</button>`;
    }

    function renderReadOnly(entry, key) {
        if (!entry) {
            const ago = daysAgo(key);
            el.sheetBody.innerHTML = '<div class="sheet-msg">No log was recorded for this day.<br>'
                + `Logs can only be added for today and yesterday — this day was ${ago} days ago.</div>`;
            el.sheetActions.innerHTML = '<div class="spacer"></div>'
                + '<button type="button" class="btn-secondary" id="cancelEntry">Close</button>';
            return;
        }

        let html = pressureStripHtml(key);
        QUESTIONS.forEach(q => {
            const v = entry[q.key];
            const val = (v === null || v === undefined)
                ? '<span style="color:#64748b;font-weight:500">Not answered</span>'
                : `<span style="color:${scoreText(v, q.polarity)}">${v}<span class="word">${q.words[v - 1]}</span></span>`;
            html += `<div class="ro-row"><span class="k">${q.short}</span><span class="v">${val}</span></div>`;
        });

        if (entry.notes) {
            html += `<div class="q" style="margin-top:20px"><span class="notes-label">Notes</span>`
                + `<div class="ro-notes">${escapeHtml(entry.notes)}</div></div>`;
        }

        const when = entry.updatedAt ? new Date(entry.updatedAt) : null;
        if (when) {
            html += `<div class="sheet-sub" style="margin-top:16px;margin-bottom:0">`
                + `Recorded ${when.toLocaleDateString()} at ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>`;
        }

        el.sheetBody.innerHTML = html;
        el.sheetActions.innerHTML = '<div class="spacer"></div>'
            + '<button type="button" class="btn-secondary" id="cancelEntry">Close</button>';
    }

    function saveEntry() {
        const notesEl = document.getElementById('entryNotes');
        const notes = notesEl ? notesEl.value.trim() : '';

        const answered = QUESTIONS.some(q => draft[q.key] !== null);
        if (!answered && !notes) {
            alert('Nothing to save yet — answer at least one question or add a note.');
            return;
        }

        if (Store.set(sheetKey, draft, notes)) {
            closeSheet();
            renderCalendar();
        }
    }

    function deleteEntry() {
        const d = parseKey(sheetKey);
        if (!confirm(`Delete the log for ${longDate(d)}? This cannot be undone.`)) return;
        Store.remove(sheetKey);
        closeSheet();
        renderCalendar();
    }

    // --- Events -----------------------------------------------------------

    function wire() {
        el.tabPressure.addEventListener('click', () => showTab('pressure'));
        el.tabSymptoms.addEventListener('click', () => showTab('symptoms'));

        el.segMonth.addEventListener('click', () => { calMode = 'month'; renderCalendar(); });
        el.segWeek.addEventListener('click', () => { calMode = 'week'; renderCalendar(); });

        el.calPrev.addEventListener('click', () => {
            anchor = calMode === 'month'
                ? new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)
                : addDays(anchor, -7);
            renderCalendar();
        });

        el.calNext.addEventListener('click', () => {
            anchor = calMode === 'month'
                ? new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)
                : addDays(anchor, 7);
            renderCalendar();
        });

        el.calToday.addEventListener('click', () => {
            anchor = startOfToday();
            renderCalendar();
        });

        el.logTodayBtn.addEventListener('click', () => openSheet(dateKey(startOfToday())));

        // Day cells are re-rendered constantly, so delegate from the container.
        el.calBody.addEventListener('click', (e) => {
            const cell = e.target.closest('[data-key]');
            if (cell) openSheet(cell.dataset.key);
        });

        // Scale buttons and sheet actions, also delegated.
        el.sheet.addEventListener('click', (e) => {
            const scoreBtn = e.target.closest('[data-score]');
            if (scoreBtn) {
                const block = scoreBtn.closest('[data-q]');
                if (block) selectScore(block.dataset.q, Number(scoreBtn.dataset.score));
                return;
            }
            const id = e.target.id;
            if (id === 'saveEntry') saveEntry();
            else if (id === 'cancelEntry') closeSheet();
            else if (id === 'deleteEntry') deleteEntry();
        });

        el.shareBackupBtn.addEventListener('click', shareBackup);
        el.downloadJsonBtn.addEventListener('click', exportJson);
        el.downloadCsvBtn.addEventListener('click', exportCsv);

        el.restoreBtn.addEventListener('click', () => el.restoreInput.click());
        el.restoreInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleImportFile(file);
            // Reset so picking the same file again still fires a change event.
            e.target.value = '';
        });

        el.backupNudge.addEventListener('click', (e) => {
            if (e.target.id === 'nudgeBackup') shareBackup();
        });

        el.backdrop.addEventListener('click', closeSheet);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && sheetKey) closeSheet();
        });
    }

    // Tapping the already-selected number clears it, so a mis-tap is undoable
    // without having to guess at a "none" value.
    function selectScore(qKey, n) {
        const q = QUESTIONS.find(x => x.key === qKey);
        if (!q) return;
        draft[qKey] = draft[qKey] === n ? null : n;
        const v = draft[qKey];

        const block = el.sheetBody.querySelector(`[data-q="${qKey}"]`);
        block.querySelectorAll('[data-score]').forEach(btn => {
            const num = Number(btn.dataset.score);
            const sel = num === v;
            btn.classList.toggle('sel', sel);
            btn.style.background = sel ? scoreFill(num, q.polarity, 0.85) : '';
        });

        const answer = block.querySelector('[data-answer]');
        answer.textContent = v === null ? 'Not answered' : q.words[v - 1];
        answer.classList.toggle('unset', v === null);
        answer.style.color = v === null ? '' : scoreText(v, q.polarity);
    }

    // --- Init -------------------------------------------------------------

    function init() {
        cacheEls();
        wire();
        Store.load();

        let saved = 'pressure';
        try { saved = localStorage.getItem(TAB_KEY) || 'pressure'; } catch (e) { /* ignore */ }
        showTab(saved === 'symptoms' ? 'symptoms' : 'pressure');
        renderCalendar();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
