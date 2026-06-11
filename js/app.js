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

  function renderAll() {
    const from = elFrom.value, to = elTo.value;
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

  renderAll();
})();
