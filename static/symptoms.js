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

    // Any past day can be created or edited — there is no cutoff. A bad stretch
    // can leave several days unrecorded, and backfilling them later is worth
    // more than enforcing recency.
    //
    // This constant now only controls the "+" hint on the calendar, not
    // permission: without a limit, every past day would carry one and the
    // month would be a wall of plus signs.
    const RECENT_PROMPT_DAYS = 1;

    const STORE_KEY = 'bp_symptom_log_v1';
    const TAB_KEY = 'bp_active_tab';

    // v2: every question runs 0 (best) to 10 (worst). v1 mixed directions and
    // ran 1-10; migrateV1ToV2() converts old entries on load.
    const SCHEMA_VERSION = 2;

    const SCALE_MIN = 0;
    const SCALE_MAX = 10;

    // Every question now runs the same way: 0 = nothing wrong, 10 = as bad as
    // it gets. The two ability questions are phrased as difficulty rather than
    // ability so the wording matches the numbers -- inverting the scale without
    // rewording would have made "10 = worst cognitive ability" read backwards.
    const QUESTIONS = [
        { key: 'headPain', label: 'How bad was your head pain?', short: 'Head', low: 'None', high: 'Worst' },
        { key: 'bodyPain', label: 'How bad was your body pain?', short: 'Body', low: 'None', high: 'Worst' },
        { key: 'cognitive', label: 'How much difficulty thinking clearly?', short: 'Mind', low: 'None', high: 'Unable' },
        { key: 'ambulatory', label: 'How much difficulty moving around?', short: 'Moving', low: 'None', high: 'Unable' },
        { key: 'overall', label: 'How bad was the day overall?', short: 'Overall', low: 'Fine', high: 'Worst' },
    ];

    // Questions whose v1 scale ran the opposite way (10 was best) and so need
    // inverting when migrating old entries.
    const V1_INVERTED_KEYS = ['cognitive', 'ambulatory', 'overall'];

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

    // Every day up to and including today can be logged or edited.
    function isEditable(key) {
        return !isFuture(key);
    }

    // Only drives the "+" nudge on recent days you'd most likely want to fill.
    function isRecent(key) {
        const ago = daysAgo(key);
        return ago >= 0 && ago <= RECENT_PROMPT_DAYS;
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

    // Every scale now runs the same way, so one mapping serves them all:
    // 0 -> green, 10 -> red.
    function scoreHue(v) {
        return Math.round(((SCALE_MAX - v) / SCALE_MAX) * 140);
    }

    function scoreFill(v, alpha) {
        return `hsla(${scoreHue(v)}, 68%, 45%, ${alpha})`;
    }

    function scoreText(v) {
        return `hsl(${scoreHue(v)}, 72%, 62%)`;
    }

    // --- Schema migration -------------------------------------------------

    // v1 ran 1-10 with mixed directions; v2 runs 0-10 with 10 always worst.
    // Converting rather than reinterpreting matters: leaving an old "cognitive
    // ability 9" (nearly normal) in place would silently become "difficulty 9"
    // (severely impaired) -- the opposite of what was recorded.
    //
    //   pain-type      1..10 (1 = none)  ->  0..9  via v - 1
    //   inverted-type  1..10 (10 = best) ->  0..9  via 10 - v
    //
    // Both preserve ordering and anchor "nothing wrong" at 0. Neither reaches
    // 10, which is correct: nobody was ever offered the new top of the scale.
    function migrateV1ToV2(oldEntries) {
        const out = {};
        Object.keys(oldEntries).forEach((key) => {
            const src = oldEntries[key];
            if (!src || typeof src !== 'object') return;

            const entry = Object.assign({}, src);
            QUESTIONS.forEach((q) => {
                const v = src[q.key];
                if (typeof v !== 'number') {
                    entry[q.key] = null;
                    return;
                }
                entry[q.key] = V1_INVERTED_KEYS.indexOf(q.key) !== -1
                    ? clampScore(10 - v)
                    : clampScore(v - 1);
            });
            entry.migratedFrom = 'v1';
            out[key] = entry;
        });
        return out;
    }

    function clampScore(v) {
        return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(v)));
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
                        const version = parsed.version || 1;
                        this._data = {
                            version: SCHEMA_VERSION,
                            entries: version < 2
                                ? migrateV1ToV2(parsed.entries)
                                : parsed.entries,
                            lastBackupAt: parsed.lastBackupAt || null,
                        };
                        // Write the converted values back immediately, so a
                        // half-migrated log can't exist if the tab is closed.
                        if (version < 2) this.persist();
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

    // --- Voice dictation --------------------------------------------------

    // Browser-native speech recognition: no API key, no backend, no cost, and
    // it keeps the app a pure static site. Supported in Chrome/Edge, Android
    // Chrome, and iOS Safari 14.5+; absent in Firefox, where the button is
    // hidden rather than shown broken.
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const SPEECH_SUPPORTED = !!SpeechRecognitionCtor;

    let recognition = null;
    let listening = false;
    let stoppedByUser = false;
    let dictationFatal = false;
    let restartCount = 0;

    // The most recent not-yet-finalised transcript. It's shown in the status
    // line but deliberately kept out of the textarea until the engine commits
    // it -- otherwise the field churns as the guess is revised. The catch is
    // that stopping or saving before that happens would silently discard words
    // the user can see on screen, so stopDictation() flushes this.
    let pendingInterim = '';

    // Mobile engines stop on their own after a pause. Restarting keeps a slow
    // speaker from being cut off mid-thought, but needs a ceiling so a
    // persistent failure can't spin forever.
    const MAX_RESTARTS = 60;

    function micButtonHtml() {
        return '<button type="button" class="mic-btn" id="micBtn" aria-label="Dictate notes">'
            + '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'
            + '<path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>'
            + '<path fill="currentColor" d="M17 11a1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21a1 1 0 1 1-2 0v-3.07A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 0 0 10 0z"/>'
            + '</svg><span id="micLabel">Speak</span></button>';
    }

    function setMicStatus(text) {
        const el = document.getElementById('micStatus');
        if (el) el.textContent = text || '';
    }

    function updateMicUi() {
        const btn = document.getElementById('micBtn');
        const label = document.getElementById('micLabel');
        if (!btn || !label) return;
        btn.classList.toggle('recording', listening);
        label.textContent = listening ? 'Stop' : 'Speak';
        btn.setAttribute('aria-label', listening ? 'Stop dictating' : 'Dictate notes');
    }

    // Append rather than replace, so dictation never destroys typed text.
    function appendToNotes(text) {
        const el = document.getElementById('entryNotes');
        if (!el) return;

        let chunk = String(text).trim();
        if (!chunk) return;

        const existing = el.value.replace(/\s+$/, '');
        // Capitalise at the start of the note and after a finished sentence,
        // so dictated and typed text read as one piece of writing.
        if (!existing || /[.!?]$/.test(existing)) {
            chunk = chunk.charAt(0).toUpperCase() + chunk.slice(1);
        }
        el.value = existing ? existing + ' ' + chunk : chunk;
        el.scrollTop = el.scrollHeight;
    }

    function startDictation() {
        if (!SPEECH_SUPPORTED || listening) return;

        stoppedByUser = false;
        dictationFatal = false;
        restartCount = 0;
        pendingInterim = '';

        recognition = new SpeechRecognitionCtor();
        recognition.lang = navigator.language || 'en-US';
        recognition.continuous = true;
        recognition.interimResults = true;

        recognition.onresult = (event) => {
            restartCount = 0;  // real speech: reset the runaway guard
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) {
                    appendToNotes(result[0].transcript);
                } else {
                    interim += result[0].transcript;
                }
            }
            // Anything finalised above is already in the field, so this also
            // clears itself back to '' and can't be committed twice.
            pendingInterim = interim;
            setMicStatus(interim ? '“' + interim + '…”' : 'Listening…');
        };

        recognition.onerror = (event) => {
            const err = event.error;
            if (err === 'not-allowed' || err === 'service-not-allowed') {
                dictationFatal = true;
                setMicStatus('Microphone access was blocked. Allow it for this site, then try again.');
            } else if (err === 'audio-capture') {
                dictationFatal = true;
                setMicStatus('No microphone was found.');
            } else if (err === 'network') {
                dictationFatal = true;
                setMicStatus('Dictation needs a connection and couldn\'t reach the service.');
            }
            // 'no-speech' and 'aborted' are routine; onend decides what happens.
        };

        recognition.onend = () => {
            if (listening && !stoppedByUser && !dictationFatal && restartCount < MAX_RESTARTS) {
                restartCount++;
                try {
                    recognition.start();
                    return;
                } catch (e) { /* fall through and stop cleanly */ }
            }
            listening = false;
            updateMicUi();
            if (!dictationFatal) setMicStatus('');
        };

        try {
            recognition.start();
            listening = true;
            updateMicUi();
            setMicStatus('Listening…');
        } catch (e) {
            listening = false;
            updateMicUi();
            setMicStatus('Could not start dictation.');
        }
    }

    function stopDictation() {
        stoppedByUser = true;
        if (recognition) {
            try { recognition.stop(); } catch (e) { /* already stopped */ }
        }

        // Commit whatever was still mid-recognition. Stopping doesn't reliably
        // deliver a final result before the caller reads the field, so without
        // this the last spoken phrase -- visible on screen the whole time --
        // would vanish on save.
        if (pendingInterim) {
            appendToNotes(pendingInterim);
            pendingInterim = '';
        }

        listening = false;
        updateMicUi();
        setMicStatus('');
    }

    function toggleDictation() {
        if (listening) stopDictation();
        else startDictation();
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
            if (inMonth && !entry && isRecent(key)) classes.push('can-add');

            let style = '';
            let score = '';
            if (entry && entry.overall !== null && entry.overall !== undefined) {
                style = ` style="background:${scoreFill(entry.overall, 0.3)};border-color:${scoreFill(entry.overall, 0.55)}"`;
                score = `<span class="dscore" style="color:${scoreText(entry.overall)}">${entry.overall}</span>`;
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
        for (let v = SCALE_MIN; v <= SCALE_MAX; v++) {
            bar += `<span style="background:${scoreFill(v, 0.75)}"></span>`;
        }
        return `<div class="cal-key"><span>0 &middot; Fine</span><span class="bar">${bar}</span>`
            + '<span>Worst &middot; 10</span></div>';
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
                        : `<span style="color:${scoreText(v)}">${v}</span>`;
                    minis += `<div class="mini"><span class="k">${q.short}</span><span class="v">${shown}</span></div>`;
                });
                const note = entry.notes
                    ? `<div class="week-note">${escapeHtml(entry.notes)}</div>`
                    : '';
                right = `<div class="week-scores">${minis}${note}</div>`;
            } else if (future) {
                right = '<div class="week-empty">—</div>';
            } else {
                right = '<div class="week-empty">Tap to add a log</div>';
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
        const d = parseKey(key);
        const rel = relativeDayName(key);

        el.sheetTitle.textContent = rel ? `${rel}` : longDate(d);
        el.sheetSub.textContent = rel ? longDate(d) : '';

        draft = {};
        QUESTIONS.forEach(q => {
            draft[q.key] = entry && typeof entry[q.key] === 'number' ? entry[q.key] : null;
        });

        // Every day the calendar lets you open is editable now, so there is
        // only one form. Future days aren't clickable and never reach here.
        renderEditForm(entry);

        el.backdrop.classList.add('open');
        el.sheet.classList.add('open');
        el.sheet.scrollTop = 0;
        document.body.style.overflow = 'hidden';
    }

    function closeSheet() {
        // Always release the microphone with the sheet. Leaving it open after
        // the UI is gone would be both a battery drain and a privacy problem.
        if (listening) stopDictation();

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
            // No word label for the chosen number -- the highlighted button
            // already says which one it is. Only the unanswered state needs
            // spelling out, since that isn't visible from the buttons.
            html += `<div class="q" data-q="${q.key}">`
                + `<div class="q-label"><span>${q.label}</span>`
                + `<span class="q-answer unset" data-answer="${q.key}">`
                + `${v === null ? 'Not answered' : ''}</span></div>`
                + '<div class="scale">';
            for (let n = SCALE_MIN; n <= SCALE_MAX; n++) {
                const sel = v === n;
                const style = sel ? ` style="background:${scoreFill(n, 0.85)}"` : '';
                html += `<button type="button" class="${sel ? 'sel' : ''}" data-score="${n}"${style}>${n}</button>`;
            }
            html += '</div>'
                + `<div class="scale-ends"><span>${SCALE_MIN} &middot; ${q.low}</span>`
                + `<span>${q.high} &middot; ${SCALE_MAX}</span></div>`
                + '</div>';
        });

        html += '<div class="q"><div class="notes-head">'
            + '<label class="notes-label" for="entryNotes">Notes (optional)</label>'
            + (SPEECH_SUPPORTED ? micButtonHtml() : '')
            + '</div>'
            + `<textarea id="entryNotes" placeholder="Triggers, medication, sleep, anything worth remembering...">${entry ? escapeHtml(entry.notes || '') : ''}</textarea>`
            + '<div class="mic-status" id="micStatus"></div>'
            + (SPEECH_SUPPORTED ? '' : '<div class="mic-status">Voice input isn\'t available in this browser. '
                + 'Your phone keyboard\'s microphone key still works.</div>')
            + '</div>';

        // Now that older days open straight into the form, say when the entry
        // was last written — useful context before changing an old record.
        const when = entry && entry.updatedAt ? new Date(entry.updatedAt) : null;
        if (when) {
            html += '<div class="sheet-sub" style="margin-top:4px;margin-bottom:0">'
                + `Last saved ${when.toLocaleDateString()} at `
                + `${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>`;
        }

        el.sheetBody.innerHTML = html;

        el.sheetActions.innerHTML =
            (entry ? '<button type="button" class="btn-danger" id="deleteEntry">Delete</button>' : '')
            + '<div class="spacer"></div>'
            + '<button type="button" class="btn-secondary" id="cancelEntry">Cancel</button>'
            + `<button type="button" class="btn-primary" id="saveEntry">${entry ? 'Update' : 'Save'}</button>`;
    }

    function saveEntry() {
        // Stop first: a pending final result would otherwise land in the
        // textarea after we've already read it, and be lost.
        if (listening) stopDictation();

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
            // Checked first: the click can land on the SVG inside the button.
            if (e.target.closest('#micBtn')) {
                toggleDictation();
                return;
            }

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
            btn.style.background = sel ? scoreFill(num, 0.85) : '';
        });

        const answer = block.querySelector('[data-answer]');
        answer.textContent = v === null ? 'Not answered' : '';
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
