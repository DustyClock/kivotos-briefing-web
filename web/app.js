(() => {
  "use strict";
  const config = window.KIVOTOS_CONFIG || {};
  const state = { token: null, preview: false, items: [], status: null, region: "all", query: "", visible: 20, schedules: ["09:00", "21:00"] };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  $("#login-button").addEventListener("click", startDeviceFlow);
  $("#preview-button").addEventListener("click", () => enterApp(true));
  $("#logout-button").addEventListener("click", logout);
  $("#collect-button").addEventListener("click", requestCollection);
  $("#search-input").addEventListener("input", (event) => { state.query = event.target.value.trim().toLocaleLowerCase(); state.visible = 20; renderNews(); });
  $("#load-more").addEventListener("click", () => { state.visible += 20; renderNews(); });
  $("#schedule-add").addEventListener("click", addSchedule);
  $("#schedule-reset").addEventListener("click", resetSchedules);
  $$(".tab").forEach((button) => button.addEventListener("click", () => switchPanel(button.dataset.view)));
  $$(".filter").forEach((button) => button.addEventListener("click", () => {
    $$(".filter").forEach((item) => item.classList.remove("active")); button.classList.add("active");
    state.region = button.dataset.region; state.visible = 20; renderNews();
  }));

  async function startDeviceFlow() {
    if (!config.githubAppClientId) {
      $("#login-help").textContent = "GitHub App Client ID가 아직 설정되지 않았습니다. 먼저 화면 미리보기를 확인할 수 있습니다.";
      return;
    }
    try {
      const body = new URLSearchParams({ client_id: config.githubAppClientId });
      if (config.githubRepositoryId) body.set("repository_id", config.githubRepositoryId);
      const response = await fetch("https://github.com/login/device/code", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body
      });
      if (!response.ok) throw new Error(`인증 코드 요청 실패 (${response.status})`);
      const device = await response.json();
      $("#device-code").textContent = device.user_code;
      $("#device-link").href = device.verification_uri;
      $("#device-code-box").classList.remove("hidden");
      window.open(device.verification_uri, "_blank", "noopener");
      await pollForToken(device);
    } catch (error) { $("#login-help").textContent = error.message; }
  }

  async function pollForToken(device) {
    let interval = Number(device.interval || 5) * 1000;
    const deadline = Date.now() + Number(device.expires_in || 900) * 1000;
    while (Date.now() < deadline) {
      await wait(interval);
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.githubAppClientId, device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
      });
      const result = await response.json();
      if (result.access_token) { state.token = result.access_token; await verifyIdentity(); return; }
      if (result.error === "slow_down") interval += 5000;
      else if (result.error && result.error !== "authorization_pending") throw new Error(`GitHub 인증 실패: ${result.error}`);
    }
    throw new Error("인증 코드가 만료되었습니다. 다시 시도해 주세요.");
  }

  async function verifyIdentity() {
    const user = await githubJson("https://api.github.com/user");
    if (Number(config.allowedGithubUserId) && Number(user.id) !== Number(config.allowedGithubUserId)) {
      state.token = null; throw new Error("허용되지 않은 GitHub 계정입니다.");
    }
    await enterApp(false);
    $("#auth-state").textContent = `${user.login} 인증됨`;
  }

  async function enterApp(preview) {
    state.preview = preview;
    $("#login-view").classList.add("hidden"); $("#app-view").classList.remove("hidden");
    if (preview) $("#auth-state").textContent = "미리보기";
    await loadDashboard();
  }

  function logout() { state.token = null; state.preview = false; state.items = []; $("#app-view").classList.add("hidden"); $("#login-view").classList.remove("hidden"); }

  async function loadDashboard() {
    try {
      const [latest, status] = await Promise.all([readData("latest.json"), readData("status.json")]);
      state.items = latest.items || []; state.status = status; renderAll(latest);
    } catch (error) {
      if (state.preview) { const demo = demoData(); state.items = demo.items; state.status = demo.status; renderAll(demo); }
      else handleApiError(error);
    }
  }

  async function readData(filename) {
    if (state.preview) { const response = await fetch(`${config.dataPath || "data"}/${filename}`, { cache: "no-store" }); if (!response.ok) throw new Error("미리보기 데이터 없음"); return response.json(); }
    const url = `https://api.github.com/repos/${config.githubOwner}/${config.privateRepository}/contents/${config.privateDataPath || "dashboard-data"}/${filename}`;
    const file = await githubJson(url); return JSON.parse(decodeURIComponent(escape(atob(file.content.replace(/\n/g, "")))));
  }

  function renderAll(latest) {
    $("#new-count").textContent = String(latest.items?.length || 0);
    $("#last-collected").textContent = `마지막 갱신 ${formatDate(latest.generated_at || state.status?.generated_at)}`;
    renderNews(); renderMonths(latest.months || []); renderSchedules(); renderStatus();
  }

  function renderNews() {
    const regionLabel = { kr: "한국", jp: "일본", global: "글로벌" };
    const categoryLabel = { maintenance: "점검", update: "업데이트", event: "이벤트", reward: "보상", recruitment: "모집", goods: "굿즈", ost: "OST", offline: "오프라인", collaboration: "콜라보", video: "영상", notice: "공지" };
    const filtered = state.items.filter((item) => {
      if (state.region !== "all" && item.region !== state.region) return false;
      const text = [item.title_ko, item.title_original, item.summary_ko, item.category, ...(item.tags || [])].filter(Boolean).join(" ").toLocaleLowerCase();
      return !state.query || text.includes(state.query);
    });
    $("#news-list").innerHTML = filtered.slice(0, state.visible).map((item) => `
      <article class="news-card">
        ${item.thumbnail_url ? `<img class="thumb" src="${escapeHtml(item.thumbnail_url)}" loading="lazy" alt="">` : `<div class="thumb"></div>`}
        <div><span class="region">${regionLabel[item.region] || item.region}</span>
          <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title_ko || item.title_original)}</a></h3>
          <p>${escapeHtml(item.summary_ko || item.title_original)}</p>
          <div class="badges"><span class="badge ${item.importance}">${importanceLabel(item.importance)}</span><span class="badge">${categoryLabel[item.category] || item.category}</span>${item.is_deleted ? '<span class="badge urgent">원문 삭제</span>' : ""}</div>
        </div><time class="news-time">${formatDate(item.published_at || item.first_seen_at)}</time>
      </article>`).join("") || '<p class="muted">조건에 맞는 소식이 없습니다.</p>';
    $("#load-more").classList.toggle("hidden", filtered.length <= state.visible);
  }

  function renderMonths(months) { $("#month-list").innerHTML = months.map((month) => `<div class="month-item"><b>${month}</b><button class="ghost" data-month="${month}">불러오기</button></div>`).join("") || '<p class="muted">아직 지난 기록이 없습니다.</p>'; }
  function renderSchedules() { state.schedules.sort(); $("#schedule-list").innerHTML = state.schedules.map((time) => `<div class="schedule-item"><b>${time}</b><button class="danger" data-delete-time="${time}">삭제</button></div>`).join(""); $$('[data-delete-time]').forEach((button) => button.addEventListener("click", () => deleteSchedule(button.dataset.deleteTime))); $("#next-run").textContent = state.schedules[0] || "없음"; }
  function renderStatus() {
    const sources = state.status?.sources || [];
    $("#source-status").innerHTML = sources.map((source) => `<div class="source-row"><div><b>${escapeHtml(source.name || source.id)}</b><small class="muted"> · ${escapeHtml(source.region || "")}</small></div><span class="status-pill">${source.consecutive_failures ? `실패 ${source.consecutive_failures}회` : "정상"}</span></div>`).join("") || '<p class="muted">상태 기록이 없습니다.</p>';
    const failures = sources.filter((source) => source.consecutive_failures).length;
    $("#service-health").textContent = failures ? "일부 오류" : "정상"; $("#health-detail").textContent = `${sources.length || 7}개 출처`;
    $("#run-history").innerHTML = (state.status?.runs || []).slice(0, 10).map((run) => `<div class="run-row"><span>실행 #${run.id} · ${escapeHtml(run.trigger_type)}</span><b>${escapeHtml(run.status)}</b></div>`).join("");
  }

  async function requestCollection() { if (!await confirmAction("지금 수집", "지금 새 소식을 확인할까요?")) return; if (state.preview) return alert("미리보기에서는 실제 수집을 요청하지 않습니다."); await dispatch(config.collectWorkflow, { trigger_type: "manual" }); alert("수집 작업을 요청했습니다."); }
  function addSchedule() { const time = $("#schedule-time").value; if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return alert("올바른 시간을 입력하세요."); if (state.schedules.includes(time)) return alert("이미 등록된 시간입니다."); if (state.schedules.length >= 6) return alert("예약은 최대 6개입니다."); state.schedules.push(time); renderSchedules(); saveSchedules(); }
  async function deleteSchedule(time) { if (!await confirmAction("예약 삭제", `${time} 예약을 삭제할까요?`)) return; state.schedules = state.schedules.filter((item) => item !== time); renderSchedules(); saveSchedules(); }
  async function resetSchedules() { if (!await confirmAction("전체 초기화", "예약 시간을 기본값 09:00, 21:00으로 초기화할까요?")) return; state.schedules = ["09:00", "21:00"]; renderSchedules(); saveSchedules(); }
  async function saveSchedules() { if (state.preview) return; await dispatch(config.scheduleWorkflow, { schedules_json: JSON.stringify(state.schedules) }); }
  async function dispatch(workflow, inputs) { const url = `https://api.github.com/repos/${config.githubOwner}/${config.privateRepository}/actions/workflows/${workflow}/dispatches`; const response = await fetch(url, { method: "POST", headers: githubHeaders(), body: JSON.stringify({ ref: "main", inputs }) }); if (!response.ok) throw await apiError(response); }
  async function githubJson(url) { const response = await fetch(url, { headers: githubHeaders() }); if (!response.ok) throw await apiError(response); return response.json(); }
  function githubHeaders() { return { Accept: "application/vnd.github+json", Authorization: `Bearer ${state.token}`, "X-GitHub-Api-Version": "2022-11-28" }; }
  async function apiError(response) { const error = new Error(`GitHub API 오류 (${response.status})`); error.status = response.status; error.reset = response.headers.get("x-ratelimit-reset"); return error; }
  function handleApiError(error) { if (error.status === 403 && error.reset) { const when = new Date(Number(error.reset) * 1000); $("#service-health").textContent = "API 한도 도달"; $("#health-detail").textContent = `${when.toLocaleTimeString("ko-KR")} 이후 재시도`; $("#collect-button").disabled = true; } else alert(error.message); }
  function switchPanel(name) { $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name)); $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${name}-panel`)); }
  function confirmAction(title, message) { const dialog = $("#confirm-dialog"); $("#dialog-title").textContent = title; $("#dialog-message").textContent = message; dialog.showModal(); return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true })); }
  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function formatDate(value) { if (!value) return "시각 미상"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function importanceLabel(value) { return { urgent: "긴급", important: "중요", normal: "일반" }[value] || value; }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
  function demoData() { const now = new Date().toISOString(); return { generated_at: now, months: [now.slice(0, 7)], items: [
    { id: 1, region: "kr", importance: "important", category: "maintenance", title_original: "정기 점검 안내", title_ko: "정기 점검 안내", summary_ko: "정기 점검 일정과 이용 안내입니다.", published_at: now, first_seen_at: now, url: "https://forum.nexon.com/bluearchive/", tags: ["maintenance"] },
    { id: 2, region: "jp", importance: "normal", category: "video", title_original: "ブルーアーカイブ 公式動画", title_ko: "블루 아카이브 공식 영상", summary_ko: "일본 공식 채널의 신규 영상입니다.", published_at: now, first_seen_at: now, url: "https://www.youtube.com/@BlueArchive_JP", tags: ["video"], thumbnail_url: "https://i.ytimg.com/vi/aqmDeMZFwt8/hqdefault.jpg" },
    { id: 3, region: "global", importance: "important", category: "event", title_original: "New Event Notice", title_ko: "신규 이벤트 안내", summary_ko: "글로벌 서버 신규 이벤트 일정 안내입니다.", published_at: now, first_seen_at: now, url: "https://forum.nexon.com/bluearchive-en/", tags: ["event"] }
  ], status: { generated_at: now, sources: ["kr_forum","kr_home","jp_news","global_forum","kr_youtube","jp_youtube","global_youtube"].map((id) => ({ id, name: id, region: id.split("_")[0], consecutive_failures: 0 })), runs: [] } }; }
})();
