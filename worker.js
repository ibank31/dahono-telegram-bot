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
//   ALLOWED_CHAT_IDS    — chat ID yg boleh akses, pisah koma (kosong = semua)
//
// AI_GATEWAY_BASE_URL   — (opsional, default: https://gateway.dahono.com/v1)
//   Set ini untuk ganti endpoint tanpa ubah kode sama sekali.
//
// Model vars (di wrangler.toml [vars]):
//   MODEL_DEFAULT, MODEL_CASUAL, MODEL_AUDIT, MODEL_PLANNER,
//   MODEL_CODER, MODEL_FAST, MODEL_REPO, MODEL_SEO, MODEL_DEBUG
//
// KV Binding (wrangler.toml):
//   [[kv_namespaces]]
//   binding = "HISTORY_KV"
//   id = "..."
// ================================================================

// ────────────────────────────────────────────────────────────────
// [1] ENDPOINT CONFIG — SATU TEMPAT UNTUK SEMUA PANGGILAN AI
// ────────────────────────────────────────────────────────────────
// Untuk ganti endpoint (misal dari Dahono ke OpenRouter, atau ke
// instance lokal): cukup ubah AI_GATEWAY_BASE_URL di wrangler.toml
// atau di Cloudflare dashboard. Tidak perlu sentuh kode sama sekali.

function getAiEndpoint(env) {
  const base = (env.AI_GATEWAY_BASE_URL || "https://gateway.dahono.com/v1")
    .replace(/\/$/, ""); // hapus trailing slash
  return `${base}/chat/completions`;
}

function getAiHeaders(env) {
  return {
    "Authorization": `Bearer ${env.DAHONO_API_KEY}`,
    "Content-Type": "application/json"
  };
}

// ────────────────────────────────────────────────────────────────
// [2] MODEL ROUTER — kriteria pemilihan model per intent
// ────────────────────────────────────────────────────────────────
//
// Hierarki prioritas (dari atas ke bawah, yang pertama match menang):
//   1. Override manual via /model <nama>  ← dikontrol user
//   2. Keyword intent dari teks pesan     ← auto-detect
//   3. MODEL_DEFAULT sebagai fallback
//
// Untuk tambah kategori baru:
//   (a) Tambah MODEL_XXX di wrangler.toml [vars]
//   (b) Tambah blok if baru di selectModel() di bawah
//   (c) Tambah keyword atau kondisi yang relevan

const MODEL_INTENT_MAP = [
  {
    name: "casual",          // Obrolan ringan, pertanyaan cepat
    envKey: "MODEL_CASUAL",
    fallbackEnvKey: "MODEL_FAST",
    keywords: [
      "halo", "hai", "hi", "hello",
      "apa kabar", "gimana", "santai", "ngobrol",
      "sebentar", "cepat", "quick", "singkat",
      "makasih", "thanks", "oke", "ok"
    ]
  },
  {
    name: "audit",           // Analisis mendalam, review, SEO
    envKey: "MODEL_AUDIT",
    keywords: [
      "audit", "seo", "review", "analisa", "analisis",
      "homepage", "landing page", "brand page",
      "cek konten", "evaluasi", "perbaiki", "benchmark"
    ]
  },
  {
    name: "planner",         // Perencanaan, roadmap, arsitektur
    envKey: "MODEL_PLANNER",
    keywords: [
      "plan", "planning", "arsitektur", "roadmap",
      "strategi", "strategy", "struktur",
      "langkah", "tahapan", "rancang", "desain sistem"
    ]
  },
  {
    name: "debug",           // Bug, error, investigasi masalah
    envKey: "MODEL_DEBUG",
    keywords: [
      "bug", "error", "debug", "masalah", "kenapa",
      "tidak bisa", "gagal", "broken", "fix",
      "investigate", "investigasi", "kenapa", "kok"
    ]
  },
  {
    name: "coder",           // Coding, refactor, buat komponen
    envKey: "MODEL_CODER",
    keywords: [
      "refactor", "buat component", "buat page", "buat fungsi",
      "nextjs", "typescript", "javascript", "react",
      "kode", "code", "coding", "tulis", "function",
      "import", "export", "hook", "api route",
      "component", "jsx", "tsx", "css", "style"
    ]
  },
  {
    name: "repo",            // Akses repo: baca file, commit, tree
    envKey: "MODEL_REPO",
    keywords: [
      "baca file", "lihat file", "read file", "isi file",
      "commit", "push", "tulis file", "update file",
      "repo", "gitlab", "branch", "list file", "cari file",
      "direktori", "folder", "tree"
    ]
  },
  {
    name: "seo",             // SEO spesifik
    envKey: "MODEL_SEO",
    keywords: [
      "meta", "schema", "title tag", "canonical",
      "keyword", "h1", "h2", "heading", "crawl",
      "indexing", "sitemap", "robots", "backlink"
    ]
  }
];

/**
 * Pilih model berdasarkan intent pesan.
 * @param {object} env   - Cloudflare env
 * @param {string} text  - Teks pesan user
 * @param {string|null} override - Model override dari /model command
 * @returns {{ model: string, intent: string }}
 */
function selectModel(env, text = "", override = null) {
  // 1. Override manual dari user
  if (override) {
    return { model: override, intent: "manual-override" };
  }

  const q = text.toLowerCase();

  // 2. Cek setiap intent (urutan penting — yang lebih spesifik di atas)
  for (const intent of MODEL_INTENT_MAP) {
    const matched = intent.keywords.some(kw => q.includes(kw));
    if (matched) {
      // Ambil model dari env, atau fallback env, atau MODEL_DEFAULT
      const model =
        env[intent.envKey] ||
        (intent.fallbackEnvKey ? env[intent.fallbackEnvKey] : null) ||
        env.MODEL_DEFAULT ||
        "dahono/claude-sonnet-4.5-agentic-free";
      return { model, intent: intent.name };
    }
  }

  // 3. Default
  const model = env.MODEL_DEFAULT || "dahono/claude-sonnet-4.5-agentic-free";
  return { model, intent: "default" };
}

// ────────────────────────────────────────────────────────────────
// SISTEM PROMPT — konteks penuh RADJA AC
// ────────────────────────────────────────────────────────────────

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

async function runAgent(conversationMessages, env, userText = "", modelOverride = null) {
  const MAX_ITERATIONS = 8;
  const messages = [...conversationMessages];

  // Tentukan model SEKALI di awal — tidak berubah per iterasi
  const { model, intent } = selectModel(env, userText, modelOverride);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await fetch(getAiEndpoint(env), {
      method: "POST",
      headers: getAiHeaders(env),
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
      if (i === 0) return await runAgentFallback(conversationMessages, env, userText, modelOverride);
      return `⚠️ AI error (iterasi ${i + 1}): ${errText.slice(0, 200)}`;
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    if (!choice) return "⚠️ Tidak ada respons dari AI.";

    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) {
      // Tambahkan info model di akhir jika bukan mode casual
      const modelNote = intent !== "casual" && intent !== "default"
        ? `\n\n_[${intent} • ${model.split("/").pop()}]_`
        : "";
      return (msg.content || "⚠️ Respons kosong.") + modelNote;
    }

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
  }

  return "⚠️ Agen melebihi batas iterasi. Coba pertanyaan lebih spesifik.";
}

// Fallback tanpa tool calling
async function runAgentFallback(messages, env, userText = "", modelOverride = null) {
  const { model } = selectModel(env, userText, modelOverride);

  const res = await fetch(getAiEndpoint(env), {
    method: "POST",
    headers: getAiHeaders(env),
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

const MAX_HISTORY_MESSAGES = 24;
const HISTORY_TTL_SECONDS = 7 * 24 * 3600;

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
// MODEL OVERRIDE PER SESSION (KV)
// Simpan pilihan /model user, persistent sampai /model reset
// ────────────────────────────────────────────────────────────────

async function loadModelOverride(env, chatId) {
  try {
    if (!env.HISTORY_KV) return null;
    return await env.HISTORY_KV.get(`m:${chatId}`);
  } catch { return null; }
}

async function saveModelOverride(env, chatId, model) {
  try {
    if (!env.HISTORY_KV) return;
    if (model === null) {
      await env.HISTORY_KV.delete(`m:${chatId}`);
    } else {
      await env.HISTORY_KV.put(`m:${chatId}`, model, { expirationTtl: 7 * 24 * 3600 });
    }
  } catch {}
}

// ────────────────────────────────────────────────────────────────
// TELEGRAM HELPERS
// ────────────────────────────────────────────────────────────────

async function tgSend(env, chatId, text) {
  const MAX_LEN = 4000;
  const chunks = [];

  let remaining = String(text);
  while (remaining.length > MAX_LEN) {
    let cut = remaining.lastIndexOf("\n", MAX_LEN);
    if (cut < MAX_LEN * 0.5) cut = MAX_LEN;
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
  if (!env.ALLOWED_CHAT_IDS) return true;
  const ids = env.ALLOWED_CHAT_IDS.split(",").map(s => s.trim());
  return ids.includes(String(chatId));
}

// ────────────────────────────────────────────────────────────────
// CORE PROCESSOR
// ────────────────────────────────────────────────────────────────

async function processUpdate(update, env) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (!isAllowed(env, chatId)) return;

  // ── /start & /help ────────────────────────────────────────
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
      `Perintah:\n` +
      `/reset — hapus history percakapan\n` +
      `/status — cek koneksi repo\n` +
      `/model — lihat & ganti model aktif\n` +
      `/debug — cek semua env vars & koneksi`
    );
    return;
  }

  // ── /reset ────────────────────────────────────────────────
  if (text === "/reset") {
    await clearHistory(env, chatId);
    await tgSend(env, chatId, "✅ History percakapan dihapus. Mulai sesi baru.");
    return;
  }

  // ── /model — lihat, ganti, atau reset model override ──────
  // Contoh penggunaan:
  //   /model                    → tampilkan model aktif & daftar pilihan
  //   /model reset              → hapus override, kembali ke auto-detect
  //   /model dahono/qwen3-coder-plus  → paksa pakai model ini
  if (text === "/model" || text.startsWith("/model ")) {
    const arg = text.replace("/model", "").trim();

    if (!arg) {
      // Tampilkan status + daftar model
      const currentOverride = await loadModelOverride(env, chatId);
      const { model: autoModel, intent: autoIntent } = selectModel(env, "", null);

      const modelLines = [
        `🤖 Model Router Status\n`,
        currentOverride
          ? `Override aktif: ${currentOverride}`
          : `Mode: auto-detect (${autoIntent} → ${autoModel})`,
        ``,
        `Daftar model di config:`,
        `  DEFAULT : ${env.MODEL_DEFAULT || "—"}`,
        `  CASUAL  : ${env.MODEL_CASUAL || env.MODEL_FAST || "—"}`,
        `  CODER   : ${env.MODEL_CODER || "—"}`,
        `  AUDIT   : ${env.MODEL_AUDIT || "—"}`,
        `  PLANNER : ${env.MODEL_PLANNER || "—"}`,
        `  DEBUG   : ${env.MODEL_DEBUG || "—"}`,
        `  SEO     : ${env.MODEL_SEO || "—"}`,
        `  REPO    : ${env.MODEL_REPO || "—"}`,
        ``,
        `Perintah:`,
        `/model reset          → kembali ke auto`,
        `/model <model-id>     → paksa pakai model ini`
      ];
      await tgSend(env, chatId, modelLines.join("\n"));
      return;
    }

    if (arg === "reset") {
      await saveModelOverride(env, chatId, null);
      await tgSend(env, chatId, "✅ Override dihapus. Kembali ke auto-detect.");
      return;
    }

    // Set override ke model yang diminta
    await saveModelOverride(env, chatId, arg);
    await tgSend(env, chatId, `✅ Model dipaksa ke: ${arg}\nKirim /model reset untuk kembali ke auto.`);
    return;
  }

  // ── /debug ────────────────────────────────────────────────
  if (text === "/debug") {
    const lines = ["🔍 Debug RADJA AC Agent\n"];

    lines.push("── Env Vars ──");
    lines.push(`TELEGRAM_TOKEN: ${env.TELEGRAM_TOKEN ? "✅" : "❌ MISSING"}`);
    lines.push(`DAHONO_API_KEY: ${env.DAHONO_API_KEY ? "✅" : "❌ MISSING"}`);
    lines.push(`GITLAB_TOKEN: ${env.GITLAB_TOKEN ? "✅" : "❌ MISSING"}`);
    lines.push(`GITLAB_PROJECT_ID: ${env.GITLAB_PROJECT_ID || "❌ MISSING"}`);
    lines.push(`HISTORY_KV: ${env.HISTORY_KV ? "✅ bound" : "❌ NOT BOUND"}`);
    lines.push(`AI_GATEWAY_BASE_URL: ${env.AI_GATEWAY_BASE_URL || "(default: gateway.dahono.com/v1)"}`);
    lines.push(`MODEL_DEFAULT: ${env.MODEL_DEFAULT || "❌ MISSING"}`);

    lines.push("\n── GitLab API ──");
    try {
      const info = await gitlabFetch(env, "");
      lines.push(info?.name
        ? `✅ ${info.name} (${info.default_branch})`
        : "❌ Gagal — cek TOKEN & PROJECT_ID");
    } catch (e) {
      lines.push(`❌ ${e.message}`);
    }

    lines.push("\n── AI API ──");
    lines.push(`Endpoint: ${getAiEndpoint(env)}`);
    try {
      const aiRes = await fetch(getAiEndpoint(env), {  // ← tidak hardcode lagi
        method: "POST",
        headers: getAiHeaders(env),
        body: JSON.stringify({
          model: env.MODEL_DEFAULT || "dahono/claude-sonnet-4.5-agentic-free",
          messages: [{ role: "user", content: "Balas hanya: OK" }],
          max_tokens: 10
        })
      });
      if (!aiRes.ok) {
        const errBody = await aiRes.text();
        lines.push(`❌ HTTP ${aiRes.status}: ${errBody.slice(0, 200)}`);
      } else {
        const aiData = await aiRes.json();
        const aiReply = aiData?.choices?.[0]?.message?.content;
        lines.push(aiReply
          ? `✅ Menjawab: "${aiReply.trim()}"`
          : `⚠️ Respons tak terduga: ${JSON.stringify(aiData).slice(0, 100)}`);
      }
    } catch (e) {
      lines.push(`❌ ${e.message}`);
    }

    // Cek model override aktif
    const override = await loadModelOverride(env, chatId);
    lines.push(`\n── Model Router ──`);
    lines.push(override ? `Override: ${override}` : `Mode: auto-detect`);

    await tgSend(env, chatId, lines.join("\n"));
    return;
  }

  // ── /status ───────────────────────────────────────────────
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

  const [history, modelOverride] = await Promise.all([
    loadHistory(env, chatId),
    loadModelOverride(env, chatId)
  ]);

  const userMsg = { role: "user", content: text };
  const workingMessages = [...history, userMsg];

  const reply = await runAgent(workingMessages, env, text, modelOverride);

  await saveHistory(env, chatId, [
    ...history,
    userMsg,
    { role: "assistant", content: reply }
  ]);

  await tgSend(env, chatId, reply);
}

// ────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK", { status: 200 });
    }

    ctx.waitUntil(
      processUpdate(update, env)
        .catch(async (err) => {
          console.error("processUpdate fatal error:", err);
          try {
            const chatId = update?.message?.chat?.id;
            if (chatId && env.TELEGRAM_TOKEN) {
              await fetch(
                `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id: chatId,
                    text: `❌ Fatal error: ${err.message?.slice(0, 200) || "unknown"}`
                  })
                }
              );
            }
          } catch {}
        })
    );

    return new Response("OK", { status: 200 });
  }
};
