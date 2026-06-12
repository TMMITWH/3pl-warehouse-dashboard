// ============================================================
// 3PL Warehouse Operations Dashboard
// Computes all report views from transaction-level rows,
// filtered live by the selected date period.
// ============================================================
(async function () {
  const { source, data } = await window.loadReportData();
  if (!data || !data.transactions || !data.transactions.length) return; // setup/login notice shown
  const TX = data.transactions;
  const RANGE = data.range;

  const fmt = (n, d = 3) => Number(n || 0).toLocaleString("en-US",
    { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
  const short = (s, n = 24) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const INK = "#121821", AMBER = "#F5A300", IMP = "#0E7C66", EXP = "#C2451E";

  Chart.defaults.font.family = '"IBM Plex Mono", monospace';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = "#46505E";

  document.getElementById("data-source").innerHTML =
    source === "supabase"
      ? "DATA SOURCE: <b>SUPABASE (LIVE)</b>"
      : "DATA SOURCE: <b>RAW EXCEL EXPORTS (EMBEDDED)</b> — connect Supabase in js/supabase.js";

  // ---------- Date period controls ----------
  const elFrom = document.getElementById("date-from");
  const elTo = document.getElementById("date-to");
  [elFrom, elTo].forEach((el) => { el.min = RANGE.min; el.max = RANGE.max; });
  elFrom.value = RANGE.min;
  elTo.value = RANGE.max;

  document.getElementById("btn-full").addEventListener("click", () => {
    elFrom.value = RANGE.min; elTo.value = RANGE.max; renderAll();
  });
  document.getElementById("btn-7d").addEventListener("click", () => {
    const end = new Date(RANGE.max);
    const start = new Date(end); start.setDate(end.getDate() - 6);
    const s = start.toISOString().slice(0, 10);
    elFrom.value = s < RANGE.min ? RANGE.min : s;
    elTo.value = RANGE.max;
    renderAll();
  });
  [elFrom, elTo].forEach((el) => el.addEventListener("change", () => {
    if (elFrom.value > elTo.value) {
      (el === elFrom ? elTo : elFrom).value = el.value;
    }
    renderAll();
  }));

  // ---------- Tabs ----------
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.panel).classList.add("active");
    });
  });

  // ---------- Aggregation from filtered transactions ----------
  function aggregate(rows) {
    const imp = rows.filter((r) => r.dir === "IMP");
    const exp = rows.filter((r) => r.dir === "EXP");
    const sumV = (a) => a.reduce((s, r) => s + r.vol, 0);

    const byKey = (list, keyFn) => {
      const m = new Map();
      list.forEach((r) => {
        const k = keyFn(r);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      });
      return m;
    };

    // Containers: unique container codes per customer (IMP only)
    const cntrRows = imp.filter((r) => r.cntr);
    const containers = [...byKey(cntrRows, (r) => r.code + "|" + r.name).entries()]
      .map(([k, g]) => {
        const [code, name] = k.split("|");
        const uniq = new Set(g.filter((r) => r.cc).map((r) => r.cc));
        return { code, name, cntr: uniq.size || g.length, vol: sumV(g) };
      }).sort((a, b) => a.code.localeCompare(b.code));

    const lclRows = imp.filter((r) => !r.cntr);
    const lcl = [...byKey(lclRows, (r) => r.code + "|" + r.name).entries()]
      .map(([k, g]) => {
        const [code, name] = k.split("|");
        return { code, name, vol: sumV(g) };
      }).sort((a, b) => a.code.localeCompare(b.code));

    const staffSet = [...new Set(rows.map((r) => r.staff))].sort();
    const staff = staffSet.map((s) => ({
      staff: s,
      imp: imp.filter((r) => r.staff === s).length,
      exp: exp.filter((r) => r.staff === s).length,
    }));

    const jobs = [...byKey(rows, (r) => r.staff + "|" + r.dir + "|" + r.name).entries()]
      .map(([k, g]) => {
        const [s, dir, party] = k.split("|");
        return { staff: s, dir, party, jobs: g.length };
      }).sort((a, b) => a.staff.localeCompare(b.staff) || a.party.localeCompare(b.party));

    const custKeys = [...new Set(rows.map((r) => r.code + "|" + r.name))].sort();
    const tx = custKeys.map((k) => {
      const [code, name] = k.split("|");
      return {
        code, name,
        imp: sumV(imp.filter((r) => r.code === code && r.name === name)),
        exp: sumV(exp.filter((r) => r.code === code && r.name === name)),
      };
    });

    const days = [...new Set(rows.map((r) => r.d))].sort();
    const daily = days.map((d) => ({
      d,
      imp: sumV(imp.filter((r) => r.d === d)),
      exp: sumV(exp.filter((r) => r.d === d)),
    }));

    const uniqueCntrs = new Set(cntrRows.filter((r) => r.cc).map((r) => r.cc));
    return {
      imp, exp, containers, lcl, staff, jobs, tx, daily,
      kpi: {
        cntrCount: uniqueCntrs.size,
        cntrVol: sumV(cntrRows),
        lclVol: sumV(lclRows),
        impJobs: imp.length,
        expJobs: exp.length,
        totVol: sumV(rows),
      },
    };
  }

  // ---------- Chart management (destroy + recreate on filter) ----------
  const charts = {};
  function makeChart(id, cfg) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
  }

  let A = null; // current aggregate, used by table search handlers
  let PERIOD = { from: "", to: "" }; // current filter, used by exports

  function renderAll() {
    const from = elFrom.value, to = elTo.value;
    PERIOD = { from, to };
    document.getElementById("period-stamp").textContent =
      `${from.split("-").reverse().join(".")} – ${to.split("-").reverse().join(".")}`;

    const rows = TX.filter((r) => r.d >= from && r.d <= to);
    A = aggregate(rows);

    // KPIs
    const kpis = [
      { label: "Containers In", value: fmtInt(A.kpi.cntrCount), unit: "CNTR", cls: "amber" },
      { label: "CNTR Volume", value: fmt(A.kpi.cntrVol, 1), unit: "CBM", cls: "amber" },
      { label: "LCL Volume", value: fmt(A.kpi.lclVol, 1), unit: "CBM", cls: "amber" },
      { label: "Inbound Jobs", value: fmtInt(A.kpi.impJobs), unit: "IMP", cls: "imp" },
      { label: "Outbound Jobs", value: fmtInt(A.kpi.expJobs), unit: "EXP", cls: "exp" },
      { label: "Total Throughput", value: fmt(A.kpi.totVol, 1), unit: "CBM", cls: "" },
    ];
    document.getElementById("kpis").innerHTML = kpis.map((k) =>
      `<div class="kpi ${k.cls}"><div class="label">${k.label}</div>
       <div class="value">${k.value}<span class="unit">${k.unit}</span></div></div>`).join("");

    // Daily trend
    makeChart("ov-daily", {
      type: "bar",
      data: {
        labels: A.daily.map((r) => r.d.slice(5).split("-").reverse().join("/")),
        datasets: [
          { label: "Inbound CBM", data: A.daily.map((r) => r.imp), backgroundColor: IMP },
          { label: "Outbound CBM", data: A.daily.map((r) => r.exp), backgroundColor: EXP },
        ],
      },
      options: {
        maintainAspectRatio: false,
        scales: { x: { grid: { display: false } }, y: { grid: { color: "#E4E7EA" } } },
        plugins: { legend: { position: "bottom" } },
      },
    });

    // Top 10 customers
    const top = [...A.tx].map((r) => ({ ...r, tot: r.imp + r.exp }))
      .sort((a, b) => b.tot - a.tot).slice(0, 10);
    makeChart("ov-volume", {
      type: "bar",
      data: {
        labels: top.map((r) => short(r.name)),
        datasets: [
          { label: "Inbound CBM", data: top.map((r) => r.imp), backgroundColor: IMP },
          { label: "Outbound CBM", data: top.map((r) => r.exp), backgroundColor: EXP },
        ],
      },
      options: {
        indexAxis: "y", maintainAspectRatio: false,
        scales: { x: { grid: { color: "#E4E7EA" } }, y: { grid: { display: false } } },
        plugins: { legend: { position: "bottom" } },
      },
    });

    // Staff stacked
    makeChart("ov-staff", {
      type: "bar",
      data: {
        labels: A.staff.map((r) => r.staff),
        datasets: [
          { label: "IMP jobs", data: A.staff.map((r) => r.imp), backgroundColor: IMP, stack: "s" },
          { label: "EXP jobs", data: A.staff.map((r) => r.exp), backgroundColor: EXP, stack: "s" },
        ],
      },
      options: {
        maintainAspectRatio: false,
        scales: { x: { stacked: true, grid: { display: false } },
                  y: { stacked: true, grid: { color: "#E4E7EA" } } },
        plugins: { legend: { position: "bottom" } },
      },
    });

    // Containers chart
    makeChart("cntr-chart", {
      type: "bar",
      data: {
        labels: A.containers.map((r) => short(r.name)),
        datasets: [
          { label: "Containers", data: A.containers.map((r) => r.cntr), backgroundColor: AMBER, yAxisID: "y" },
          { label: "Volume CBM", data: A.containers.map((r) => r.vol), backgroundColor: INK, yAxisID: "y1" },
        ],
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false } },
          y: { position: "left", title: { display: true, text: "CNTR" }, grid: { color: "#E4E7EA" } },
          y1: { position: "right", title: { display: true, text: "CBM" }, grid: { display: false } },
        },
        plugins: { legend: { position: "bottom" } },
      },
    });

    // LCL chart
    const lclSorted = [...A.lcl].sort((a, b) => b.vol - a.vol);
    makeChart("lcl-chart", {
      type: "bar",
      data: {
        labels: lclSorted.map((r) => short(r.name)),
        datasets: [{ label: "LCL Volume CBM", data: lclSorted.map((r) => r.vol), backgroundColor: AMBER }],
      },
      options: {
        indexAxis: "y", maintainAspectRatio: false,
        scales: { x: { grid: { color: "#E4E7EA" } }, y: { grid: { display: false } } },
        plugins: { legend: { display: false } },
      },
    });

    // Customer transactions chart
    makeChart("tx-chart", {
      type: "bar",
      data: {
        labels: top.map((r) => short(r.name)),
        datasets: [{ label: "Total CBM", data: top.map((r) => r.tot), backgroundColor: INK }],
      },
      options: {
        indexAxis: "y", maintainAspectRatio: false,
        scales: { x: { grid: { color: "#E4E7EA" } }, y: { grid: { display: false } } },
        plugins: { legend: { display: false } },
      },
    });

    drawCntrTable(); drawLclTable(); drawStaffTable(); drawJobs(); drawTxTable();
  }

  // ---------- Tables ----------
  const q = (id) => document.getElementById(id).value.toLowerCase();
  const sumK = (a, k) => a.reduce((s, r) => s + Number(r[k] || 0), 0);

  function drawCntrTable() {
    const list = A.containers.filter((r) =>
      (r.code + " " + r.name).toLowerCase().includes(q("cntr-search")));
    const t = document.getElementById("cntr-table");
    t.querySelector("tbody").innerHTML = list.map((r) =>
      `<tr><td class="code">${r.code}</td><td>${r.name}</td>
       <td class="num">${fmtInt(r.cntr)}</td><td class="num">${fmt(r.vol)}</td></tr>`).join("");
    t.querySelector("tfoot").innerHTML =
      `<tr><td colspan="2">Grand Total</td><td class="num">${fmtInt(sumK(list, "cntr"))}</td>
       <td class="num">${fmt(sumK(list, "vol"))}</td></tr>`;
  }

  function drawLclTable() {
    const list = A.lcl.filter((r) =>
      (r.code + " " + r.name).toLowerCase().includes(q("lcl-search")));
    const t = document.getElementById("lcl-table");
    t.querySelector("tbody").innerHTML = list.map((r) =>
      `<tr><td class="code">${r.code}</td><td>${r.name}</td><td class="num">${fmt(r.vol)}</td></tr>`).join("");
    t.querySelector("tfoot").innerHTML =
      `<tr><td colspan="2">Grand Total</td><td class="num">${fmt(sumK(list, "vol"))}</td></tr>`;
  }

  function drawStaffTable() {
    const list = A.staff.filter((r) => r.staff.toLowerCase().includes(q("staff-search")));
    const t = document.getElementById("staff-table");
    t.querySelector("tbody").innerHTML = list.map((r) =>
      `<tr><td class="code">${r.staff}</td><td class="num">${fmtInt(r.imp)}</td>
       <td class="num">${fmtInt(r.exp)}</td><td class="num"><b>${fmtInt(r.imp + r.exp)}</b></td></tr>`).join("");
    t.querySelector("tfoot").innerHTML =
      `<tr><td>Grand Total</td><td class="num">${fmtInt(sumK(list, "imp"))}</td>
       <td class="num">${fmtInt(sumK(list, "exp"))}</td>
       <td class="num">${fmtInt(sumK(list, "imp") + sumK(list, "exp"))}</td></tr>`;
  }

  function drawJobs() {
    const staffSel = document.getElementById("jobs-staff");
    const current = staffSel.value;
    const staffList = [...new Set(A.jobs.map((r) => r.staff))].sort();
    staffSel.innerHTML = `<option value="ALL">All staff</option>` +
      staffList.map((s) => `<option value="${s}">${s}</option>`).join("");
    staffSel.value = staffList.includes(current) || current === "ALL" ? current : "ALL";

    const dir = document.getElementById("jobs-dir").value;
    const query = q("jobs-search");
    const list = A.jobs.filter((r) =>
      (staffSel.value === "ALL" || r.staff === staffSel.value) &&
      (dir === "ALL" || r.dir === dir) &&
      (r.party.toLowerCase().includes(query) || r.staff.toLowerCase().includes(query)));
    document.querySelector("#jobs-table tbody").innerHTML = list.map((r) =>
      `<tr><td class="code">${r.staff}</td>
       <td><span class="badge ${r.dir.toLowerCase()}">${r.dir}</span></td>
       <td>${r.party}</td><td class="num">${fmtInt(r.jobs)}</td></tr>`).join("");
    document.querySelector("#jobs-table tfoot").innerHTML =
      `<tr><td colspan="3">Grand Total</td><td class="num">${fmtInt(sumK(list, "jobs"))}</td></tr>`;
  }

  function drawTxTable() {
    const list = A.tx.filter((r) =>
      (r.code + " " + r.name).toLowerCase().includes(q("tx-search")));
    const t = document.getElementById("tx-table");
    t.querySelector("tbody").innerHTML = list.map((r) =>
      `<tr><td class="code">${r.code}</td><td>${r.name}</td>
       <td class="num">${r.imp ? fmt(r.imp) : "—"}</td>
       <td class="num">${r.exp ? fmt(r.exp) : "—"}</td>
       <td class="num"><b>${fmt(r.imp + r.exp)}</b></td></tr>`).join("");
    t.querySelector("tfoot").innerHTML =
      `<tr><td colspan="2">Grand Total</td><td class="num">${fmt(sumK(list, "imp"))}</td>
       <td class="num">${fmt(sumK(list, "exp"))}</td>
       <td class="num">${fmt(sumK(list, "imp") + sumK(list, "exp"))}</td></tr>`;
  }

  document.getElementById("cntr-search").addEventListener("input", drawCntrTable);
  document.getElementById("lcl-search").addEventListener("input", drawLclTable);
  document.getElementById("staff-search").addEventListener("input", drawStaffTable);
  document.getElementById("jobs-staff").addEventListener("change", drawJobs);
  document.getElementById("jobs-dir").addEventListener("change", drawJobs);
  document.getElementById("jobs-search").addEventListener("input", drawJobs);
  document.getElementById("tx-search").addEventListener("input", drawTxTable);

  // ================= EXPORTS =================
  const r3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;

  function exportExcel() {
    if (!A || typeof XLSX === "undefined") return;
    const wb = XLSX.utils.book_new();
    const add = (name, aoa, widths) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      if (widths) ws["!cols"] = widths.map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    };

    add("Summary", [
      ["3PL WAREHOUSE OPERATIONS REPORT"],
      ["Period", `${PERIOD.from} to ${PERIOD.to}`],
      ["Generated", new Date().toLocaleString()],
      [],
      ["KPI", "Value"],
      ["Containers In", A.kpi.cntrCount],
      ["Container Volume (CBM)", r3(A.kpi.cntrVol)],
      ["LCL Volume (CBM)", r3(A.kpi.lclVol)],
      ["Inbound Jobs", A.kpi.impJobs],
      ["Outbound Jobs", A.kpi.expJobs],
      ["Total Throughput (CBM)", r3(A.kpi.totVol)],
    ], [30, 26]);

    add("Inbound Containers", [
      ["Code", "Principal", "Containers", "Volume CBM"],
      ...A.containers.map((r) => [r.code, r.name, r.cntr, r3(r.vol)]),
      ["", "GRAND TOTAL", sumK(A.containers, "cntr"), r3(sumK(A.containers, "vol"))],
    ], [8, 42, 12, 12]);

    add("Inbound LCL", [
      ["Code", "Principal", "LCL Volume CBM"],
      ...A.lcl.map((r) => [r.code, r.name, r3(r.vol)]),
      ["", "GRAND TOTAL", r3(sumK(A.lcl, "vol"))],
    ], [8, 42, 16]);

    add("Staff Jobs", [
      ["User", "IMP", "EXP", "Total"],
      ...A.staff.map((r) => [r.staff, r.imp, r.exp, r.imp + r.exp]),
      ["GRAND TOTAL", sumK(A.staff, "imp"), sumK(A.staff, "exp"),
       sumK(A.staff, "imp") + sumK(A.staff, "exp")],
    ], [16, 8, 8, 8]);

    add("In-Out Jobs", [
      ["Created By", "Direction", "Customer / Party", "Jobs"],
      ...A.jobs.map((r) => [r.staff, r.dir, r.party, r.jobs]),
      ["", "", "GRAND TOTAL", sumK(A.jobs, "jobs")],
    ], [16, 10, 42, 8]);

    add("Customer Transactions", [
      ["Code", "Principal", "IMP Vol", "EXP Vol", "Total Vol"],
      ...A.tx.map((r) => [r.code, r.name, r3(r.imp), r3(r.exp), r3(r.imp + r.exp)]),
      ["", "GRAND TOTAL", r3(sumK(A.tx, "imp")), r3(sumK(A.tx, "exp")),
       r3(sumK(A.tx, "imp") + sumK(A.tx, "exp"))],
    ], [8, 42, 12, 12, 12]);

    add("Daily Volumes", [
      ["Date", "Inbound CBM", "Outbound CBM", "Total CBM"],
      ...A.daily.map((r) => [r.d, r3(r.imp), r3(r.exp), r3(r.imp + r.exp)]),
      ["GRAND TOTAL", r3(sumK(A.daily, "imp")), r3(sumK(A.daily, "exp")),
       r3(sumK(A.daily, "imp") + sumK(A.daily, "exp"))],
    ], [12, 14, 14, 14]);

    XLSX.writeFile(wb, `warehouse_report_${PERIOD.from}_to_${PERIOD.to}.xlsx`);
  }

  function printReport() {
    if (!A) return;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const tbl = (headers, rows, foot) =>
      `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows.map((r) => `<tr>${r.map((c, i) =>
        `<td class="${i >= headers.length - (headers.length > 2 ? headers.length - 2 : 1) && typeof c !== "string" ? "n" : (typeof c === "number" ? "n" : "")}">${typeof c === "number" ? c.toLocaleString("en-US", { maximumFractionDigits: 3 }) : esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>` +
      (foot ? `<tfoot><tr>${foot.map((c) => `<td class="${typeof c === "number" ? "n" : ""}">${typeof c === "number" ? c.toLocaleString("en-US", { maximumFractionDigits: 3 }) : esc(c)}</td>`).join("")}</tr></tfoot>` : "") +
      `</table>`;

    const html = `<!DOCTYPE html><html><head><title>Warehouse Report ${PERIOD.from} to ${PERIOD.to}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; color: #121821; margin: 24px; }
  h1 { font-size: 18px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 2px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 14px; }
  h2 { font-size: 13px; text-transform: uppercase; border-bottom: 2px solid #121821;
       padding-bottom: 3px; margin: 18px 0 6px; page-break-after: avoid; }
  table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
       border-bottom: 1.5px solid #121821; padding: 4px 6px; }
  td { padding: 3px 6px; border-bottom: 0.5px solid #ccc; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: bold; border-top: 1.5px solid #121821; border-bottom: none; }
  .kpis { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .kpi { border: 1px solid #121821; border-top: 4px solid #F5A300; padding: 6px 12px; }
  .kpi b { display: block; font-size: 16px; }
  .kpi span { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #555; }
  @media print { .kpi { -webkit-print-color-adjust: exact; } }
</style></head><body>
<h1>3PL Warehouse Operations Report</h1>
<div class="meta">Period: <b>${PERIOD.from} to ${PERIOD.to}</b> &nbsp;·&nbsp; Generated: ${new Date().toLocaleString()}</div>
<div class="kpis">
  <div class="kpi"><span>Containers In</span><b>${A.kpi.cntrCount.toLocaleString()}</b></div>
  <div class="kpi"><span>CNTR Vol CBM</span><b>${r3(A.kpi.cntrVol).toLocaleString()}</b></div>
  <div class="kpi"><span>LCL Vol CBM</span><b>${r3(A.kpi.lclVol).toLocaleString()}</b></div>
  <div class="kpi"><span>Inbound Jobs</span><b>${A.kpi.impJobs.toLocaleString()}</b></div>
  <div class="kpi"><span>Outbound Jobs</span><b>${A.kpi.expJobs.toLocaleString()}</b></div>
  <div class="kpi"><span>Total CBM</span><b>${r3(A.kpi.totVol).toLocaleString()}</b></div>
</div>
<h2>Daily Volumes</h2>
${tbl(["Date", "Inbound CBM", "Outbound CBM", "Total CBM"],
  A.daily.map((r) => [r.d, r3(r.imp), r3(r.exp), r3(r.imp + r.exp)]),
  ["Grand Total", r3(sumK(A.daily, "imp")), r3(sumK(A.daily, "exp")), r3(sumK(A.daily, "imp") + sumK(A.daily, "exp"))])}
<h2>Inbound Status — Containers</h2>
${tbl(["Code", "Principal", "Containers", "Volume CBM"],
  A.containers.map((r) => [r.code, r.name, r.cntr, r3(r.vol)]),
  ["", "Grand Total", sumK(A.containers, "cntr"), r3(sumK(A.containers, "vol"))])}
<h2>Inbound Status — LCL</h2>
${tbl(["Code", "Principal", "LCL Volume CBM"],
  A.lcl.map((r) => [r.code, r.name, r3(r.vol)]),
  ["", "Grand Total", r3(sumK(A.lcl, "vol"))])}
<h2>Staff-wise Confirmed Jobs</h2>
${tbl(["User", "IMP", "EXP", "Total"],
  A.staff.map((r) => [r.staff, r.imp, r.exp, r.imp + r.exp]),
  ["Grand Total", sumK(A.staff, "imp"), sumK(A.staff, "exp"), sumK(A.staff, "imp") + sumK(A.staff, "exp")])}
<h2>Staff-wise Customer Inbound &amp; Outbound Jobs</h2>
${tbl(["Created By", "Dir", "Customer / Party", "Jobs"],
  A.jobs.map((r) => [r.staff, r.dir, r.party, r.jobs]),
  ["", "", "Grand Total", sumK(A.jobs, "jobs")])}
<h2>Customer-wise Transactions In &amp; Out</h2>
${tbl(["Code", "Principal", "IMP Vol", "EXP Vol", "Total Vol"],
  A.tx.map((r) => [r.code, r.name, r3(r.imp), r3(r.exp), r3(r.imp + r.exp)]),
  ["", "Grand Total", r3(sumK(A.tx, "imp")), r3(sumK(A.tx, "exp")), r3(sumK(A.tx, "imp") + sumK(A.tx, "exp"))])}
<script>window.onload = function(){ window.print(); };<\/script>
</body></html>`;

    const w = window.open("", "_blank");
    if (!w) { alert("Please allow pop-ups for this site to print the report."); return; }
    w.document.write(html);
    w.document.close();
  }

  document.getElementById("btn-excel").addEventListener("click", exportExcel);
  document.getElementById("btn-print").addEventListener("click", printReport);

  renderAll();
})();
