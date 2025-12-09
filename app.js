/**
 * Alkegen Scheduler v7.0 - Robust UI & Logic
 */

const SB_URL = 'https://tihzqfpyfanohnazvkcx.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpaHpxZnB5ZmFub2huYXp2a2N4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2NzY5MDAsImV4cCI6MjA4MDI1MjkwMH0.-ZbsX_CDTpNG3FRfH2KZcJjoj61z6JfHWQ7_cWyXAv0';
const sb = supabase.createClient(SB_URL, SB_KEY);

const CONFIG = {
    machines: [
        'Card 1', 'Card 2', 'Card 3', 'Card 4', 'Card 5', 'Card 6', 'Card 7', 'Card 8', 'Card 9',
        'Bruckner 1', 'Bruckner 2', 'Kusters', 'Singer 1', 'Singer 2', 
        'Perkins', 'Hunter', 'Dilo', 'Fehrer 228', 'Heatset', 'Needleloom',
        'QC 1', 'QC 2', 'QC 3', 'QC 4', 'QC 5', 'QC 6', 'QC 7', 'QC 8', 'QC Lab'
    ],
    defaults: { card: 250, finish: 700, qc: 400 },
    setupPenalty: 4,
    campaign: true
};

let RATES = {};
let DOWNTIME = [];
let ROUTES = {}; 
let STAFFING = {}; 
let OVERRIDES = {}; 

let RAW_ORDERS = [];
let SCHEDULE = [];
let DAY_LOADS = {};
let WORKER = null;
let ZOOM_PX = 60;
let CHARTS = {};
let USER_ROLE = 'viewer';

// --- AUTH & INIT ---

async function handleLogin() {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
        document.getElementById('loginError').innerText = error.message;
        document.getElementById('loginError').classList.remove('hidden');
    } else {
        initApp(data.user);
    }
}

async function handleLogout() {
    await sb.auth.signOut();
    window.location.reload();
}

async function initApp(user) {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    document.getElementById('userEmailDisplay').innerText = user.email;

    try {
        const { data, error } = await sb.from('user_roles').select('role').eq('id', user.id).single();
        if (data && data.role) USER_ROLE = data.role;
    } catch (e) { console.log('Role fetch failed'); }
    
    if(user.email.includes('admin') || user.email === 'admin@alkegen.com') USER_ROLE = 'admin';

    document.getElementById('userRoleBadge').innerText = USER_ROLE.charAt(0).toUpperCase() + USER_ROLE.slice(1);
    if (USER_ROLE === 'admin') document.body.classList.add('is-admin');

    document.getElementById('simDate').valueAsDate = new Date();
    CONFIG.machines.forEach(m => STAFFING[m] = [true, true, true]);
    
    initWorker();
    initUI();
    renderStaffingTable();
    await loadFromDB();
    loadLocalState(); 

    const mainScroll = document.getElementById('mainScroll');
    const headerScroll = document.getElementById('timelineHeaderWrapper');
    mainScroll.addEventListener('scroll', () => {
        if(headerScroll) headerScroll.scrollLeft = mainScroll.scrollLeft;
    });
}

// --- DATA PERSISTENCE ---

async function loadFromDB() {
    try {
        const { data: dt } = await sb.from('downtime').select('*');
        if(dt) {
            DOWNTIME = dt.map(d => ({
                id: d.id, machine: d.machine, start: new Date(d.start_time).getTime(), end: new Date(d.end_time).getTime(), reason: d.reason
            }));
            renderDowntimeTable();
        }
        const { data: rt } = await sb.from('rates').select('*');
        if(rt) {
            rt.forEach(r => {
                RATES[r.felt_code] = { card: r.card_rate, finish: r.finish_rate, qc: r.qc_rate };
            });
            renderRatesTable();
        }
    } catch(e) { console.log('DB load skipped'); }
}

function saveLocalState() {
    localStorage.setItem('alkegen_orders', JSON.stringify(RAW_ORDERS));
    localStorage.setItem('alkegen_routes', JSON.stringify(ROUTES));
    localStorage.setItem('alkegen_overrides', JSON.stringify(OVERRIDES));
}

function loadLocalState() {
    const o = localStorage.getItem('alkegen_orders');
    const r = localStorage.getItem('alkegen_routes');
    const ov = localStorage.getItem('alkegen_overrides');
    
    if(o) { RAW_ORDERS = JSON.parse(o); document.getElementById('orderStatus').innerText = `${RAW_ORDERS.length} Orders Restored`; document.getElementById('orderStatus').className = "text-green-600 text-xs"; }
    if(r) { ROUTES = JSON.parse(r); renderSequencingTable(); }
    if(ov) OVERRIDES = JSON.parse(ov);
}

document.addEventListener('DOMContentLoaded', async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (session) initApp(session.user);
    populateDropdowns();
});

// --- WORKER & PARSING ---

function initWorker() {
    const blob = new Blob([document.getElementById('worker-script').textContent], {type: "text/javascript"});
    WORKER = new Worker(window.URL.createObjectURL(blob));
    WORKER.onmessage = (e) => {
        SCHEDULE = e.data.schedule;
        DAY_LOADS = e.data.dayLoads;
        renderAll();
        renderKPIs();
        document.getElementById('engineStatus').innerText = "ONLINE";
        document.getElementById('engineStatus').className = "text-green-600 font-bold";
        document.getElementById('uploadModal').style.display = 'none';
        saveLocalState();
    };
}

function readFile(file) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => resolve(XLSX.read(new Uint8Array(e.target.result), {type: 'array'}));
        reader.readAsArrayBuffer(file);
    });
}

async function handleOrderUpload(inp) {
    const wb = await readFile(inp.files[0]);
    let rows = [];
    for(const sn of wb.SheetNames) {
        const lower = sn.toLowerCase();
        if(lower.includes('detail') || lower.includes('data') || lower.includes('sheet2')) {
             rows = XLSX.utils.sheet_to_json(wb.Sheets[sn]);
             break;
        }
    }
    if(!rows.length) rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

    RAW_ORDERS = rows.map((r, i) => {
        let o = { id:`UNK-${i}`, felt:'Unknown', qty:0, wip:0, val:0, status:'', fiber:'Generic' };
        for(let k in r) {
            const ck = k.toUpperCase().trim();
            const val = r[k];
            if(ck.includes('ORDER') && ck.includes('ID')) o.id = val;
            else if(ck === 'FELTCODE' || ck === 'FELT CODE') o.felt = val;
            else if(ck === 'BALANCE' || ck === 'BAL YDS' || ck === 'YARDSORD') o.qty = parseFloat(val)||0;
            else if(ck === 'YARDSWIP' || ck === 'WIP') o.wip = parseFloat(val)||0;
            else if(ck.includes('SALES') || ck.includes('VAL')) o.val = parseFloat(val)||0;
            else if(ck.includes('RTS') || ck === 'REQDATE') o.rtsRaw = val;
            else if(ck.includes('STATUS') || ck.includes('PRODUCTION AREA')) o.status = val;
            else if(ck.includes('FIBER') && ck.includes('DESC')) o.fiber = val;
        }
        if(typeof o.rtsRaw === 'number') o.rtsDate = new Date(Math.round((o.rtsRaw - 25569)*86400*1000)).getTime();
        else if(o.rtsRaw) o.rtsDate = new Date(o.rtsRaw).getTime();
        else o.rtsDate = new Date('2099-12-31').getTime();
        return o;
    }).filter(o => o.qty > 0);

    document.getElementById('orderStatus').innerText = `${RAW_ORDERS.length} Orders Loaded`;
    document.getElementById('orderStatus').className = "text-green-600 text-xs";
    saveLocalState();
}

async function handleRateUpload(inp) {
    const wb = await readFile(inp.files[0]);
    const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    data.forEach(r => {
        const code = r['Felt Code'] || r['Code'];
        if(code) {
            RATES[code.trim()] = {
                card: parseFloat(r['Carding Rate (yds/hr)'] || 250),
                finish: parseFloat(r['Finishing Rate (yds/hr)'] || 700),
                qc: parseFloat(r['QC Rate (yds/hr)'] || 400)
            };
        }
    });
    document.getElementById('rateStatus').innerText = "Rates Loaded";
    document.getElementById('rateStatus').className = "text-green-600 text-xs";
    renderRatesTable();
}

async function handleRouteUpload(inp) {
    const wb = await readFile(inp.files[0]);
    let sheetName = wb.SheetNames.find(n => n.includes('Sheet4')) || wb.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
    
    let tempRoutes = {};
    let grouped = {};
    data.forEach(r => {
        const felt = r['FELTCODE'];
        if(!felt) return;
        if(!grouped[felt]) grouped[felt] = [];
        grouped[felt].push({ mach: r['MACHNAME'], order: parseInt(r['MACHORD'] || 1) });
    });

    Object.keys(grouped).forEach(felt => {
        const entries = grouped[felt];
        entries.sort((a,b) => a.order - b.order);
        let steps = [];
        let currentOrder = -1;
        entries.forEach(e => {
            const normMach = CONFIG.machines.find(m => m.toUpperCase().replace(/\s/g,'') === e.mach.toUpperCase().replace(/\s/g,'').replace('#','')) || e.mach;
            if(e.order !== currentOrder) {
                steps.push({ step: e.order, pool: [normMach] });
                currentOrder = e.order;
            } else {
                steps[steps.length-1].pool.push(normMach);
            }
        });
        tempRoutes[felt] = steps;
    });

    ROUTES = tempRoutes;
    document.getElementById('routeStatus').innerText = "Digital Schedule Parsed";
    document.getElementById('routeStatus').className = "text-green-600 text-xs";
    renderSequencingTable();
    saveLocalState();
}

// --- UI RENDERING ---

function renderAll() {
    const tbody = document.getElementById('taskTableBody');
    const timelineHeader = document.getElementById('timelineHeader');
    const timelineBody = document.getElementById('timelineBody');
    
    tbody.innerHTML = '';
    timelineHeader.innerHTML = '';
    timelineBody.innerHTML = '';

    if(!SCHEDULE.length) return;

    const now = document.getElementById('simDate').valueAsDate.getTime();
    const maxEnd = Math.max(...SCHEDULE.map(d=>d.globalEnd)) || now;
    const totalDays = Math.ceil((maxEnd - now) / 86400000) + 10;
    const width = totalDays * ZOOM_PX;

    timelineHeader.style.width = `${width}px`;
    const startDayIdx = Math.floor(now / 86400000);
    
    const headerFrag = document.createDocumentFragment();
    for(let i=0; i<totalDays; i++) {
        const t = now + (i * 86400000);
        const d = new Date(t);
        const isWk = d.getDay()===0 || d.getDay()===6;
        const load = DAY_LOADS[startDayIdx + i] || 0;
        const heatClass = load > 200 ? 'bg-red-500' : (load > 100 ? 'bg-amber-400' : 'bg-green-500');
        
        const div = document.createElement('div');
        div.className = `day-col ${isWk?'weekend':''}`;
        div.style.width = `${ZOOM_PX}px`;
        div.innerHTML = `
            <span class="mt-2 font-bold">${d.getDate()}</span>
            <span style="font-size:9px">${d.toLocaleString('default',{month:'short'})}</span>
            <div class="absolute bottom-0 left-0 right-0 h-1 ${heatClass} opacity-50"></div>
        `;
        headerFrag.appendChild(div);
    }
    timelineHeader.appendChild(headerFrag);

    const tableFrag = document.createDocumentFragment();
    const chartFrag = document.createDocumentFragment();

    SCHEDULE.forEach(row => {
        const isForced = OVERRIDES[row.id];
        
        const tr = document.createElement('tr');
        if(row.isLate) tr.classList.add('late-row');
        tr.innerHTML = `
            <td><span class="inline-block w-2 h-2 rounded-full mr-2 ${row.isLate?'bg-red-500':'bg-green-500'}"></span>${row.status || 'New'}</td>
            <td class="font-mono text-xs cursor-pointer hover:text-blue-600 underline ${isForced?'override-text':''}" onclick="openEditModal('${row.id}')">${row.id} ${isForced?'*':''}</td>
            <td class="font-bold text-blue-600 text-xs">${row.felt}</td>
            <td class="text-[9px] text-slate-500 truncate" title="${row.fiber}">${row.fiber || '-'}</td>
            <td class="text-[9px] text-slate-500 truncate">${row.status || '-'}</td>
            <td class="text-right font-mono text-xs">${row.qty.toLocaleString()}</td>
        `;
        tableFrag.appendChild(tr);

        const trDiv = document.createElement('div');
        trDiv.className = 'chart-row';
        trDiv.style.width = `${width}px`;

        const drawBar = (task, name) => {
            if(!task.start || task.mach === 'Err' || task.mach === '-') return;
            const startPx = ((task.start - now) / 86400000) * ZOOM_PX;
            const durPx = Math.max(((task.end - task.start) / 86400000) * ZOOM_PX, 4);
            
            let type = 'fin';
            const mUp = task.mach.toUpperCase();
            if(mUp.includes('CARD')) type = 'card';
            else if(mUp.includes('QC')) type = 'qc';

            const b = document.createElement('div');
            b.className = `bar bar-${type} ${isForced?'bar-forced':''}`;
            b.style.left = `${startPx}px`;
            b.style.width = `${durPx}px`;
            b.innerText = task.mach;
            b.onclick = () => openEditModal(row.id);
            b.onmouseover = (e) => showTooltip(e, `${row.id} (${row.felt})\n${task.mach}\nStep: ${name}\n${new Date(task.start).toLocaleString()} - ${new Date(task.end).toLocaleString()}`);
            b.onmouseout = () => document.getElementById('tooltip').style.display='none';
            trDiv.appendChild(b);
        };

        if (row.allocations && row.allocations.length > 0) {
            row.allocations.forEach(alloc => drawBar(alloc, alloc.stepName));
        } else {
            drawBar(row.card, 'Card');
            drawBar(row.fin, 'Finish');
            drawBar(row.qc, 'QC');
        }
        chartFrag.appendChild(trDiv);
    });

    tbody.appendChild(tableFrag);
    timelineBody.appendChild(chartFrag);
}

// --- SEQUENCING TAB ---
function renderSequencingTable() {
    const tb = document.getElementById('sequencingTableBody');
    tb.innerHTML = Object.keys(ROUTES).sort().map(f => {
        const steps = ROUTES[f];
        const routeStr = steps.map(s => `[${s.pool.join('/')}]`).join(' <i class="fa-solid fa-arrow-right text-xs mx-1 text-slate-300"></i> ');
        return `
        <tr class="hover:bg-slate-50 border-b border-slate-100">
            <td class="p-4 font-bold text-blue-600">${f}</td>
            <td class="p-4 text-xs font-mono">${routeStr}</td>
            <td class="p-4 text-center">
                <button onclick="openRouteEdit('${f}')" class="text-blue-500 hover:underline text-xs admin-only"><i class="fa-solid fa-pen"></i></button>
            </td>
        </tr>`;
    }).join('');
}

function openRouteEdit(felt) {
    if(USER_ROLE !== 'admin') return alert('Admin only');
    const steps = ROUTES[felt] || [];
    const str = steps.map(s => s.pool.join('/')).join(', ');
    document.getElementById('editRouteFelt').innerText = felt;
    document.getElementById('editRouteString').value = str;
    document.getElementById('editRouteModal').style.display = 'flex';
}

function saveRouteEdit() {
    const felt = document.getElementById('editRouteFelt').innerText;
    const raw = document.getElementById('editRouteString').value;
    const parts = raw.split(',');
    
    const newSteps = parts.map((p, i) => {
        const machines = p.split('/').map(m => m.trim());
        return { step: i+1, pool: machines };
    });

    ROUTES[felt] = newSteps;
    document.getElementById('editRouteModal').style.display = 'none';
    renderSequencingTable();
    saveLocalState();
    runEngine();
}

// --- RATES TAB ---
function renderRatesTable() {
    const tb = document.getElementById('ratesTableBody');
    tb.innerHTML = Object.keys(RATES).sort().map(k => `
        <tr class="hover:bg-slate-50 transition">
            <td class="p-4 font-mono text-blue-600 font-bold">${k}</td>
            <td class="p-4 text-right">${RATES[k].card}</td>
            <td class="p-4 text-right">${RATES[k].finish}</td>
            <td class="p-4 text-right">${RATES[k].qc}</td>
            <td class="p-4 text-center">
                <button class="text-blue-500 hover:text-blue-700 mr-2 admin-only" onclick="openRateEdit('${k}')"><i class="fa-solid fa-pen"></i></button>
                <button class="text-red-400 hover:text-red-600 admin-only" onclick="deleteRate('${k}')"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>`).join('');
}

function openRateEdit(felt) {
    if(USER_ROLE !== 'admin') return alert('Admin only');
    const r = RATES[felt];
    document.getElementById('editRateFelt').innerText = felt;
    document.getElementById('editRateCard').value = r.card;
    document.getElementById('editRateFin').value = r.finish;
    document.getElementById('editRateQC').value = r.qc;
    document.getElementById('editRateModal').style.display = 'flex';
}

function saveRateEdit() {
    const felt = document.getElementById('editRateFelt').innerText;
    const c = parseFloat(document.getElementById('editRateCard').value);
    const f = parseFloat(document.getElementById('editRateFin').value);
    const q = parseFloat(document.getElementById('editRateQC').value);
    
    RATES[felt] = { card:c, finish:f, qc:q };
    document.getElementById('editRateModal').style.display = 'none';
    renderRatesTable();
    runEngine();
}

function applyMassRate() {
    if(USER_ROLE !== 'admin') return alert('Admin only');
    const filter = document.getElementById('massRateFilter').value.toUpperCase();
    const c = parseFloat(document.getElementById('massRateCard').value);
    const f = parseFloat(document.getElementById('massRateFin').value);
    const q = parseFloat(document.getElementById('massRateQC').value);
    
    Object.keys(RATES).forEach(k => {
        if(k.toUpperCase().includes(filter)) {
            if(c) RATES[k].card = c;
            if(f) RATES[k].finish = f;
            if(q) RATES[k].qc = q;
        }
    });
    document.getElementById('massRateModal').style.display='none';
    renderRatesTable();
    runEngine();
}

function addNewRateRow() {
    if(USER_ROLE !== 'admin') return alert('Admin only');
    const f = prompt("Enter Felt Code:");
    if(f) {
        RATES[f] = { card:250, finish:700, qc:400 };
        renderRatesTable();
    }
}

// --- STAFFING TAB ---
function renderStaffingTable() {
    const tb = document.getElementById('staffingTableBody');
    tb.innerHTML = '';
    CONFIG.machines.forEach(m => {
        const s = STAFFING[m];
        tb.innerHTML += `
            <tr class="border-b border-slate-100 hover:bg-slate-50">
                <td class="p-4 font-bold text-slate-700">${m}</td>
                <td class="p-4 text-center"><input type="checkbox" ${s[0]?'checked':''} onchange="updateStaffing('${m}', 0, this.checked)" class="w-5 h-5 text-blue-600 rounded"></td>
                <td class="p-4 text-center"><input type="checkbox" ${s[1]?'checked':''} onchange="updateStaffing('${m}', 1, this.checked)" class="w-5 h-5 text-blue-600 rounded"></td>
                <td class="p-4 text-center"><input type="checkbox" ${s[2]?'checked':''} onchange="updateStaffing('${m}', 2, this.checked)" class="w-5 h-5 text-blue-600 rounded"></td>
            </tr>
        `;
    });
}
function updateStaffing(m, i, v) { STAFFING[m][i] = v; }

// --- EDIT ORDER MODAL ---
function openEditModal(oid) {
    const o = RAW_ORDERS.find(x => x.id === oid);
    if(!o) return;
    document.getElementById('editOrderId').innerText = oid;
    document.getElementById('editQty').value = o.qty;
    document.getElementById('editFelt').value = o.felt;
    
    const ov = OVERRIDES[oid] || {};
    document.getElementById('forceCard').value = ov.card || "";
    document.getElementById('forceFin').value = ov.fin || "";
    document.getElementById('forceQC').value = ov.qc || "";
    
    document.getElementById('editOrderModal').style.display = 'flex';
}

function saveOrderEdit() {
    if(USER_ROLE !== 'admin') return alert('Admin only');
    const oid = document.getElementById('editOrderId').innerText;
    const q = parseFloat(document.getElementById('editQty').value);
    
    const idx = RAW_ORDERS.findIndex(x => x.id === oid);
    if(idx > -1) RAW_ORDERS[idx].qty = q;
    
    const fc = document.getElementById('forceCard').value;
    const ff = document.getElementById('forceFin').value;
    const fq = document.getElementById('forceQC').value;
    
    if(fc || ff || fq) {
        OVERRIDES[oid] = { card: fc, fin: ff, qc: fq };
    } else {
        delete OVERRIDES[oid];
    }
    
    document.getElementById('editOrderModal').style.display = 'none';
    saveLocalState();
    runEngine();
}

function initUI() { populateDropdowns(); }

function populateDropdowns() {
    ['dtMachine', 'massSeqCard', 'massSeqFin', 'forceCard', 'forceFin', 'forceQC'].forEach(id => {
        const sel = document.getElementById(id);
        if(!sel) return;
        const isFilter = id.includes('massSeq') || id.includes('force');
        sel.innerHTML = isFilter ? '<option value="">Auto (Engine)</option>' : '';
        CONFIG.machines.forEach(m => sel.innerHTML += `<option value="${m}">${m}</option>`);
    });
}

function runEngine() {
    if(!RAW_ORDERS.length) return;
    document.getElementById('engineStatus').innerText = "SOLVING...";
    document.getElementById('engineStatus').className = "text-yellow-600 animate-pulse";
    
    const simStart = document.getElementById('simDate').valueAsDate 
        ? document.getElementById('simDate').valueAsDate.getTime() 
        : new Date().setHours(8,0,0,0);

    const activeOrders = RAW_ORDERS.filter(o => {
        const s = (o.status || '').toUpperCase();
        if (s.includes('SHIPPED') || s.includes('CLOSE') || s.includes('COMPLETE') || s.includes('INVOICED')) return false;
        if (o.qty <= 10) return false;
        return true;
    });

    WORKER.postMessage({
        orders: activeOrders,
        rates: RATES,
        config: CONFIG,
        downtime: DOWNTIME,
        simStart: simStart,
        routes: ROUTES,
        staffing: STAFFING,
        overrides: OVERRIDES
    });
}

// Global UI Helpers
function switchView(view) {
    document.querySelectorAll('[id^="view-"]').forEach(el => el.classList.add('hidden'));
    document.getElementById('view-'+view).classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-'+view).classList.add('active');
    if(view==='kpi') renderKPIs();
}
function showModal(id) { 
    if(id !== 'uploadModal' && USER_ROLE !== 'admin') return alert("Admin only"); 
    document.getElementById(id).style.display = 'flex'; 
}
function changeZoom(d) { ZOOM_PX = Math.max(20, Math.min(200, ZOOM_PX + d)); renderAll(); }
function showTooltip(e, txt) {
    const tt = document.getElementById('tooltip');
    tt.style.display = 'block';
    tt.style.left = e.pageX + 10 + 'px';
    tt.style.top = e.pageY + 10 + 'px';
    tt.innerText = txt;
}
function renderKPIs() {
    const totYds = SCHEDULE.reduce((a,b)=>a+b.qty,0);
    const totRev = SCHEDULE.reduce((a,b)=>a+b.val,0);
    const lateVal = SCHEDULE.filter(x=>x.isLate).reduce((a,b)=>a+b.val,0);
    
    document.getElementById('kpiYds').innerText = totYds.toLocaleString();
    document.getElementById('kpiRev').innerText = '$' + (totRev/1000000).toFixed(2) + 'M';
    document.getElementById('kpiLate').innerText = '$' + lateVal.toLocaleString();
    
    if(CHARTS.load) CHARTS.load.destroy();
    if(CHARTS.rev) CHARTS.rev.destroy();

    const machLoad = {};
    const revData = {};
    SCHEDULE.forEach(r => {
        const allocs = r.allocations || [r.card, r.fin, r.qc];
        allocs.forEach(t => {
            if(t.mach && t.mach!=='Err' && t.mach !== '-') machLoad[t.mach] = (machLoad[t.mach]||0) + r.qty;
        });
        const m = new Date(r.globalEnd).toLocaleString('default',{month:'short'});
        revData[m] = (revData[m]||0) + r.val;
    });

    CHARTS.load = new Chart(document.getElementById('chartLoad'), {
        type: 'bar',
        data: { labels: Object.keys(machLoad), datasets: [{ label: 'Yards', data: Object.values(machLoad), backgroundColor: '#3b82f6' }] },
        options: { responsive: true, maintainAspectRatio: false }
    });

    CHARTS.rev = new Chart(document.getElementById('chartRev'), {
        type: 'line',
        data: { labels: Object.keys(revData), datasets: [{ label: 'Revenue', data: Object.values(revData), borderColor: '#22c55e', fill: true, backgroundColor:'rgba(34,197,94,0.1)' }] },
        options: { responsive: true, maintainAspectRatio: false }
    });
}
function addDowntime() {
    if(USER_ROLE !== 'admin') return alert('Admin only');
    const m = document.getElementById('dtMachine').value;
    const s = document.getElementById('dtStart').value;
    const e = document.getElementById('dtEnd').value;
    if (!m || !s || !e) return;
    DOWNTIME.push({ id: 'temp-'+Date.now(), machine: m, start: new Date(s).getTime(), end: new Date(e).getTime(), reason: 'Planned' });
    renderDowntimeTable();
    runEngine();
}
function renderDowntimeTable() {
    const tb = document.getElementById('dtBody');
    tb.innerHTML = DOWNTIME.map((d, i) => `
        <tr class="border-b border-slate-100">
            <td class="p-4 font-bold text-slate-700">${d.machine}</td>
            <td class="p-4 text-slate-500">${new Date(d.start).toLocaleString()}</td>
            <td class="p-4 text-slate-500">${new Date(d.end).toLocaleString()}</td>
            <td class="p-4 text-slate-500 italic">${d.reason}</td>
            <td class="p-4 text-center"><button class="text-red-500 hover:text-red-700 admin-only" onclick="remDT(${i})"><i class="fa-solid fa-trash"></i></button></td>
        </tr>
    `).join('');
}
function remDT(i) { DOWNTIME.splice(i, 1); renderDowntimeTable(); runEngine(); }
