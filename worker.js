// ================================================================
// RADJA AC Telegram Agent — worker.js
// Cloudflare Worker | GitLab API | Tool Calling | KV History
// ================================================================
//
// Env vars yang dibutuhkan (Cloudflare dashboard > Variables):
//   TELEGRAM_TOKEN      — bot token dari @BotFather
//   GITLAB_TOKEN        — GitLab personal access token (api scope)
//   GITLAB_PROJECT_ID   — project ID (angka, dari Settings > General)
//   DAHONO_API_KEY      — API key gateway AI
//   DEFAULT_BRANCH      — (opsional, default: main)
//   AI_MODEL            — (opsional, default: dahono/qwen-coder-plus)
//   ALLOWED_CHAT_IDS    — chat ID yg boleh akses, pisah koma (kosong = semua)
//
// KV Binding (wrangler.toml):
//   [[kv_namespaces]]
//   binding = "HISTORY_KV"
//   id = "..."   ← isi dari: wrangler kv:namespace create HISTORY_KV
// ================================================================

// ────────────────────────────────────────────────────────────────
// SISTEM PROMPT — konteks penuh RADJA AC
// ────────────────────────────────────────────────────────────────

function selectModel(env, text = "") {

  const q = text.toLowerCase();

  if (
    q.includes("audit") ||
    q.includes("seo") ||
    q.includes("homepage") ||
    q.includes("landing page") ||
    q.includes("brand page")
  ) {
    return env.MODEL_AUDIT || env.MODEL_DEFAULT;
  }

  if (
    q.includes("plan") ||
    q.includes("arsitektur") ||
    q.includes("roadmap") ||
    q.includes("strategy")
  ) {
    return env.MODEL_PLANNER || env.MODEL_DEFAULT;
  }

  if (
    q.includes("bug") ||
    q.includes("error") ||
    q.includes("debug")
  ) {
    return env.MODEL_DEBUG || env.MODEL_DEFAULT;
  }

  if (
    q.includes("refactor") ||
    q.includes("buat component") ||
    q.includes("buat page") ||
    q.includes("nextjs") ||
    q.includes("typescript") ||
    q.includes("javascript") ||
    q.includes("react")
  ) {
    return env.MODEL_CODER || env.MODEL_DEFAULT;
  }

  return env.MODEL_DEFAULT ||
    "dahono/claude-sonnet-4.5-agentic-free";
}

const SYSTEM_PROMPT = `Kamu adalah AI agent senior untuk proyek radjaac.com — website AC multi-brand yang dikelola di GitLab dengan stack Next.js App Router + Cloudflare Pages.

IDENTITAS BISNIS:
- Nama: RADJA AC
- URL: radjaac.com
- Lokasi fisik: Banyumas, Jawa Tengah (HANYA ini — jangan klaim cabang/toko di kota lain)
- Target market: seluruh Pulau Jawa
- Tujuan utama: lead WhatsApp berkualitas
- Brand yang dijual: Daikin, Sharp, Panasonic, Midea, Sansui, Ariston, Gree, Hisense, Samsung
- Status resmi: Proshop Gree, Authorized Dealer Daikin/Midea/Hisense/Sansui

STRUKTUR REPO:
- app/                 → Next.js routes (App Router, SSG)
- components/          → React components
- content/             → semua data konten:
  - areas/             → data area per kabupaten/kota
  - brands.js          → 10 brand live
  - routes.js          → daftar URL aktif
  - area-drafts.js     → draft staged (belum live)
  - site.js            → data sitewide
- lib/                 → helper (seo.js, schema.js, url.js, dll)
- docs/                → source of truth & strategi
- scripts/             → audit tools (validate-areas.mjs, dll)
- public/_headers      → Cloudflare cache rules
- AGENTS.md            → instruksi agent (baca dulu sebelum edit)

DOCS PENTING (baca sebelum task tertentu):
- docs/RADJA_WORKFLOW.md               → workflow semua pekerjaan
- docs/source/radjaac/RADJAAC_DO_NOT_VIOLATE_RULES.md → guardrail keras
- docs/RADJA_GROWTH_STRATEGY.md        → arah bisnis & prioritas
- docs/source/radjaac/RADJAAC_AREA_PAGE_BLUEPRINT.md  → template area page
- docs/source/radjaac/RADJAAC_SCHEMA_RULES.md         → aturan schema markup

GUARDRAIL KERAS (jangan pernah dilanggar):
1. Jangan klaim toko/showroom fisik di luar Banyumas
2. Jangan hardcode harga atau stok pasti ("termurah", "ready semua", "harga pasti")
3. Jangan duplikasi schema antara React Helmet dan Cloudflare Functions layer
4. Jangan pakai schema LocalBusiness untuk kota target yang bukan lokasi nyata
5. Garansi instalasi BERBEDA dari garansi produk/brand — jangan campur
6. Jangan commit sebelum baca file aslinya dulu
7. Jangan publish halaman baru tanpa internal link masuk & keluar
8. Jangan ganti URL existing tanpa daftar redirect 301
9. RADJA AC tidak "mengganti" unit rusak — hanya jual & pasang unit baru

CARA KERJA AGENT:
- Jawab natural dalam Bahasa Indonesia, ringkas untuk layar HP
- Gunakan tools untuk baca/tulis file sebelum memberi saran
- Untuk perubahan besar: baca docs strategi dulu, baru baca file source, baru modifikasi
- Minta konfirmasi sebelum commit jika perubahan signifikan
- Jika tidak yakin tentang bisnis/klaim, cek docs/source/radjaac/ dulu
- Selalu beri action items yang konkret dan langsung bisa dieksekusi`;

// ────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Baca isi file dari GitLab repo. Gunakan sebelum memberi saran atau sebelum menulis perubahan.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path file dalam repo, contoh: app/page.js atau content/areas/banyumas.js"
          }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Daftar semua file dalam repo atau dalam folder tertentu.",
      parameters: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description: "Hanya tampilkan file dalam folder ini, contoh: content/areas (opsional, kosong = semua file)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Cari file berdasarkan nama atau sebagian path.",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "Kata kunci untuk mencari nama file, contoh: cilacap atau AreaFaq"
          }
        },
        required: ["keyword"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Tulis atau update file di repo (langsung commit ke GitLab). WAJIB baca file aslinya dulu dengan read_file sebelum menulis. Konfirmasi ke user sebelum commit perubahan besar.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path file yang akan ditulis/diupdate"
          },
          content: {
            type: "string",
            description: "Isi file lengkap (complete file content, bukan diff/patch)"
          },
          commit_message: {
            type: "string",
            description: "Pesan commit yang jelas, contoh: feat(area): tambah nearbyAreaLinks ke cilacap"
          }
        },
        required: ["path", "content", "commit_message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_repo_info",
      description: "Dapatkan info repo: nama, branch default, last activity, URL.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_commits",
      description: "Lihat daftar commit terbaru.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Jumlah commit (default 10, max 20)"
          }
        }
      }
    }
  }
];

// ────────────────────────────────────────────────────────────────
// GITLAB HELPERS
// ────────────────────────────────────────────────────────────────

async function gitlabFetch(env, apiPath) {
  const res = await fetch(
    `https://gitlab.com/api/v4/projects/${env.GITLAB_PROJECT_ID}/${apiPath}`,
    { headers: { "PRIVATE-TOKEN": env.GITLAB_TOKEN } }
  );
  if (!res.ok) return null;
  return res.json();
}

async function readFile(env, filePath) {
  const branch = env.DEFAULT_BRANCH || "main";
  const data = await gitlabFetch(
    env,
    `repository/files/${encodeURIComponent(filePath)}?ref=${branch}`
  );
  if (!data?.content) return null;
  try { return atob(data.content); } catch { return null; }
}

async function writeFile(env, filePath, content, commitMessage) {
  const branch = env.DEFAULT_BRANCH || "main";

  // Check if file exists to decide POST vs PUT
  const existing = await gitlabFetch(
    env,
    `repository/files/${encodeURIComponent(filePath)}?ref=${branch}`
  );

  const body = {
    branch,
    content,
    commit_message: commitMessage || `[bot] update ${filePath}`
  };
  if (existing?.last_commit_id) body.last_commit_id = existing.last_commit_id;

  const res = await fetch(
    `https://gitlab.com/api/v4/projects/${env.GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}`,
    {
      method: existing ? "PUT" : "POST",
      headers: {
        "PRIVATE-TOKEN": env.GITLAB_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: err.slice(0, 500) };
  }
  return { ok: true };
}

async function listFiles(env, prefix = "") {
  const query = prefix
    ? `repository/tree?recursive=true&per_page=500&path=${encodeURIComponent(prefix)}`
    : "repository/tree?recursive=true&per_page=500";
  const data = await gitlabFetch(env, query);
  if (!Array.isArray(data)) return [];
  return data.filter(f => f.type === "blob").map(f => f.path);
}

// ────────────────────────────────────────────────────────────────
// TOOL EXECUTOR
// ────────────────────────────────────────────────────────────────

async function executeTool(name, args, env) {
  try {
    switch (name) {

      case "read_file": {
        const content = await readFile(env, args.path);
        if (content === null) return `❌ File tidak ditemukan: ${args.path}`;
        const MAX = 14000;
        if (content.length > MAX) {
          return content.slice(0, MAX) +
            `\n\n... [DIPOTONG: ${content.length} chars total. Minta bagian tertentu jika perlu.]`;
        }
        return content;
      }

      case "list_files": {
        const files = await listFiles(env, args.prefix || "");
        if (!files.length) return "Tidak ada file ditemukan.";
        // Group by folder for readability
        return files.join("\n");
      }

      case "search_files": {
        const all = await listFiles(env);
        const kw = (args.keyword || "").toLowerCase();
        const matches = all.filter(f => f.toLowerCase().includes(kw));
        if (!matches.length) return `Tidak ada file yang cocok dengan "${args.keyword}"`;
        return matches.join("\n");
      }

      case "write_file": {
        if (!args.path || !args.content) {
          return "❌ path dan content wajib ada.";
        }
        const result = await writeFile(env, args.path, args.content, args.commit_message);
        if (result.ok) return `✅ Committed: ${args.path}\nPesan: ${args.commit_message}`;
        return `❌ Gagal commit ke ${args.path}:\n${result.error}`;
      }

      case "get_repo_info": {
        const info = await gitlabFetch(env, "");
        if (!info) return "❌ Tidak bisa ambil info repo.";
        return [
          `Repo: ${info.name}`,
          `Branch: ${info.default_branch}`,
          `Visibility: ${info.visibility}`,
          `Last activity: ${info.last_activity_at?.slice(0, 10)}`,
          `URL: ${info.web_url}`
        ].join("\n");
      }

      case "get_commits": {
        const limit = Math.min(Number(args.limit) || 10, 20);
        const commits = await gitlabFetch(
          env, `repository/commits?per_page=${limit}`
        );
        if (!Array.isArray(commits)) return "❌ Gagal ambil commits.";
        return commits
          .map(c => `${c.short_id} | ${c.authored_date?.slice(0, 10)} | ${c.title}`)
          .join("\n");
      }

      default:
        return `Tool tidak dikenal: ${name}`;
    }
  } catch (err) {
    return `❌ Error tool ${name}: ${err.message}`;
  }
}

// ────────────────────────────────────────────────────────────────
// AGENTIC LOOP
// ────────────────────────────────────────────────────────────────

async function runAgent(
  conversationMessages,
  env,
  userText = ""
) {
  const MAX_ITERATIONS = 8;
  const messages = [...conversationMessages];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Mendapatkan model yang tepat berdasarkan userText
    const model = selectModel(env, userText);

    const res = await fetch("https://gateway.dahono.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.DAHONO_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages
        ],
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 2500,
        temperature: 0.2
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      // Fallback: try without tools (compatibility mode)
      if (i === 0) return await runAgentFallback(
        conversationMessages,
        env,
        userText
      );
      return `⚠️ AI error (iterasi ${i + 1}): ${errText.slice(0, 200)}`;
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    if (!choice) return "⚠️ Tidak ada respons dari AI.";

    const msg = choice.message;
    messages.push(msg);

    // AI selesai & tidak minta tools → return jawaban
    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) {
      return msg.content || "⚠️ Respons kosong.";
    }

    // Eksekusi semua tool calls secara paralel
    const toolResults = await Promise.all(
      msg.tool_calls.map(async (tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        const result = await executeTool(tc.function.name, args, env);
        return {
          role: "tool",
          tool_call_id: tc.id,
          content: String(result)
        };
      })
    );

    messages.push(...toolResults);
    // Loop lagi — AI akan proses hasil tool
  }

  return "⚠️ Agen melebihi batas iterasi. Coba pertanyaan lebih spesifik.";
}

// Fallback tanpa tool calling (jika gateway tidak support)
async function runAgentFallback(
  messages,
  env,
  userText = ""
) {
  // Mendapatkan model yang tepat berdasarkan userText
  const model = selectModel(env, userText);

  const res = await fetch("https://gateway.dahono.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.DAHONO_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages
      ],
      max_tokens: 2000,
      temperature: 0.2
    })
  });

  if (!res.ok) return "⚠️ Tidak bisa menghubungi AI.";
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "⚠️ Tidak ada jawaban.";
}

// ────────────────────────────────────────────────────────────────
// CONVERSATION HISTORY (KV)
// ────────────────────────────────────────────────────────────────

const MAX_HISTORY_MESSAGES = 24; // simpan 12 turn terakhir (user+assistant)
const HISTORY_TTL_SECONDS = 7 * 24 * 3600; // 7 hari

async function loadHistory(env, chatId) {
  try {
    if (!env.HISTORY_KV) return [];
    const raw = await env.HISTORY_KV.get(`h:${chatId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveHistory(env, chatId, messages) {
  try {
    if (!env.HISTORY_KV) return;
    // Simpan hanya pesan user/assistant (bukan tool calls — terlalu verbose)
    const clean = messages.filter(m => m.role === "user" || m.role === "assistant");
    const trimmed = clean.slice(-MAX_HISTORY_MESSAGES);
    await env.HISTORY_KV.put(
      `h:${chatId}`,
      JSON.stringify(trimmed),
      { expirationTtl: HISTORY_TTL_SECONDS }
    );
  } catch {}
}

async function clearHistory(env, chatId) {
  try {
    if (!env.HISTORY_KV) return;
    await env.HISTORY_KV.delete(`h:${chatId}`);
  } catch {}
}

// ────────────────────────────────────────────────────────────────
// TELEGRAM HELPERS
// ────────────────────────────────────────────────────────────────

async function tgSend(env, chatId, text) {
  const MAX_LEN = 4000;
  const chunks = [];

  // Split at newline boundaries jika terlalu panjang
  let remaining = String(text);
  while (remaining.length > MAX_LEN) {
    let cut = remaining.lastIndexOf("\n", MAX_LEN);
    if (cut < MAX_LEN * 0.5) cut = MAX_LEN; // fallback hard cut
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk })
      }
    );
  }
}

async function tgTyping(env, chatId) {
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendChatAction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" })
    }
  ).catch(() => {});
}

// ────────────────────────────────────────────────────────────────
// SECURITY CHECK
// ────────────────────────────────────────────────────────────────

function isAllowed(env, chatId) {
  if (!env.ALLOWED_CHAT_IDS) return true; // open jika tidak dikonfigurasi
  const ids = env.ALLOWED_CHAT_IDS.split(",").map(s => s.trim());
  return ids.includes(String(chatId));
}

// ────────────────────────────────────────────────────────────────
// CORE PROCESSOR (berjalan async via ctx.waitUntil)
// ────────────────────────────────────────────────────────────────

async function processUpdate(update, env) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  // Security gate
  if (!isAllowed(env, chatId)) return;

  // ── Special commands ──────────────────────────────────────
  if (text === "/start" || text === "/help") {
    await tgSend(env, chatId,
      `👋 RADJA AC Agent aktif!\n\n` +
      `Bicara natural — tidak perlu command khusus. Contoh:\n\n` +
      `• "Audit homepage dari sisi SEO"\n` +
      `• "Lihat isi file content/areas/cilacap.js"\n` +
      `• "Ada error apa di area pages?"\n` +
      `• "Tambahkan nearbyAreaLinks ke Banyumas"\n` +
      `• "Apa commit terakhir yang masuk?"\n` +
      `• "Jelaskan struktur repo ini"\n\n` +
      `/reset — hapus history percakapan\n` +
      `/status — cek koneksi ke repo`
    );
    return;
  }

  if (text === "/reset") {
    await clearHistory(env, chatId);
    await tgSend(env, chatId, "✅ History percakapan dihapus. Mulai sesi baru.");
    return;
  }

  if (text === "/status") {
    const info = await gitlabFetch(env, "").catch(() => null);
    if (info) {
      await tgSend(env, chatId,
        `✅ Koneksi OK\n` +
        `Repo: ${info.name}\n` +
        `Branch: ${info.default_branch}\n` +
        `Update: ${info.last_activity_at?.slice(0, 10)}`
      );
    } else {
      await tgSend(env, chatId, "❌ Tidak bisa konek ke GitLab. Cek GITLAB_TOKEN dan GITLAB_PROJECT_ID.");
    }
    return;
  }

  // ── Agent flow ────────────────────────────────────────────
  await tgTyping(env, chatId);

  const history = await loadHistory(env, chatId);
  const userMsg = { role: "user", content: text };
  const workingMessages = [...history, userMsg];

  const reply = await runAgent(
    workingMessages,
    env,
    text
  );

  // Simpan ke history (user + assistant, tanpa tool messages)
  await saveHistory(env, chatId, [
    ...history,
    userMsg,
    { role: "assistant", content: reply }
  ]);

  await tgSend(env, chatId, reply);
}

// ────────────────────────────────────────────────────────────────
// MAIN EXPORT — return 200 langsung, proses async
// ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Telegram butuh respons cepat — proses di background
    ctx.waitUntil(
      request.json()
        .then(update => processUpdate(update, env))
        .catch(err => console.error("Agent error:", err))
    );

    return new Response("OK", { status: 200 });
  }
};
