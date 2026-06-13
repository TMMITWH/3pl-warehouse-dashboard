window.SUPABASE_CONFIG = {
  url: "https://ykrwrrrperqfvevaobct.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrcndycnJwZXJxZnZldmFvYmN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNjI4MjUsImV4cCI6MjA5NjczODgyNX0.hu3a_TfUa05cNiWuNxRrxOveDepPapMC2V-KC6wFgl0"
};
// ============================================================
// Supabase connection + team login (private data)
// ------------------------------------------------------------
// 1. Create a project at https://supabase.com
// 2. SQL Editor: run supabase/schema.sql, then load data with
//    etl/process_report.py --push (or run seed_generated.sql)
// 3. Authentication -> Users -> "Add user" for each team member
//    (email + password). Public signup stays disabled.
// 4. Paste Project URL + anon key below (Settings -> API).
//    With the authenticated-only RLS policy, the anon key alone
//    CANNOT read any data — a team login is always required.
// ============================================================


// ---------- login overlay ----------
function authOverlay() {
  let el = document.getElementById("auth-overlay");
  if (el) return el;
  el = document.createElement("div");
  el.id = "auth-overlay";
  el.className = "auth-overlay";
  el.innerHTML = `
    <div class="auth-card">
      <div class="auth-sub">3PL Warehouse · Restricted</div>
      <h2>Team Sign In</h2>
      <form id="auth-form">
        <input type="email" id="auth-email" placeholder="email" autocomplete="username" required />
        <input type="password" id="auth-pass" placeholder="password" autocomplete="current-password" required />
        <button type="submit" class="btn" id="auth-btn">Sign In</button>
        <div class="auth-error" id="auth-error"></div>
      </form>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function showAuthMessage(html) {
  const el = authOverlay();
  el.querySelector(".auth-card").innerHTML =
    `<div class="auth-sub">3PL Warehouse · Setup</div>${html}`;
}

function requireLogin(client) {
  return new Promise((resolve) => {
    const el = authOverlay();
    el.style.display = "flex";
    el.querySelector("#auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = el.querySelector("#auth-btn");
      const err = el.querySelector("#auth-error");
      btn.disabled = true; btn.textContent = "Signing in…"; err.textContent = "";
      const { data, error } = await client.auth.signInWithPassword({
        email: el.querySelector("#auth-email").value.trim(),
        password: el.querySelector("#auth-pass").value,
      });
      if (error) {
        err.textContent = error.message;
        btn.disabled = false; btn.textContent = "Sign In";
        return;
      }
      el.style.display = "none";
      resolve(data.session);
    });
  });
}

function addLogoutButton(client) {
  const row = document.querySelector(".plate-row");
  if (!row || document.getElementById("btn-logout")) return;
  const b = document.createElement("button");
  b.id = "btn-logout";
  b.className = "btn btn-logout";
  b.type = "button";
  b.textContent = "Sign Out";
  b.addEventListener("click", async () => {
    await client.auth.signOut();
    location.reload();
  });
  row.appendChild(b);
}

// ---------- data loading ----------
async function fetchTransactions(client) {
  const pageSize = 1000;
  let from = 0, all = [];
  for (;;) {
    const { data: page, error } = await client
      .from("warehouse_transactions")
      .select("tx_date, direction, staff, prin_code, prin_name, vol_cbm, is_container, container_code")
      .order("tx_date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  if (!all.length) throw new Error("warehouse_transactions is empty — run the ETL with --push");
  const transactions = all.map((r) => ({
    d: r.tx_date, dir: r.direction, staff: r.staff,
    code: r.prin_code, name: r.prin_name,
    vol: Number(r.vol_cbm), cntr: !!r.is_container, cc: r.container_code || ""
  }));
  const dates = transactions.map((t) => t.d).sort();
  return { range: { min: dates[0], max: dates[dates.length - 1] }, transactions };
}

window.loadReportData = async function () {
  const cfg = window.SUPABASE_CONFIG;
  const local = window.REPORT_DATA;
  const hasLocal = local && local.transactions && local.transactions.length;

  // No Supabase configured: allow local preview only if an embedded
  // dataset exists (ETL --embed, for local development only).
  if (!cfg.url || !cfg.anonKey || !window.supabase) {
    if (hasLocal) return { source: "local", data: local };
    showAuthMessage(
      `<h2>Not Configured</h2>
       <p class="auth-note">Add your Supabase Project URL and anon key in
       <b>js/supabase.js</b>, or generate a local preview dataset with
       <b>etl/process_report.py --embed</b>.</p>`);
    return { source: "none", data: null };
  }

  const client = window.supabase.createClient(cfg.url, cfg.anonKey);
  let { data: { session } } = await client.auth.getSession();
  if (!session) session = await requireLogin(client);
  addLogoutButton(client);

  try {
    const data = await fetchTransactions(client);
    return { source: "supabase", data };
  } catch (err) {
    console.warn("Supabase fetch failed:", err.message);
    if (hasLocal) return { source: "local", data: local };
    showAuthMessage(`<h2>No Data</h2><p class="auth-note">${err.message}</p>`);
    authOverlay().style.display = "flex";
    return { source: "none", data: null };
  }
};
