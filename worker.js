async function sendTelegram(env, chatId, text) {
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000)
      })
    }
  );
}

async function getRepoTree(env) {
  const res = await fetch(
    `https://gitlab.com/api/v4/projects/${env.GITLAB_PROJECT_ID}/repository/tree?recursive=true&per_page=1000`,
    {
      headers: {
        "PRIVATE-TOKEN": env.GITLAB_TOKEN
      }
    }
  );

  return await res.json();
}

async function readGitlabFile(env, path) {
  const res = await fetch(
    `https://gitlab.com/api/v4/projects/${env.GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(path)}?ref=${env.DEFAULT_BRANCH || "main"}`,
    {
      headers: {
        "PRIVATE-TOKEN": env.GITLAB_TOKEN
      }
    }
  );

  if (!res.ok) return null;

  const data = await res.json();

  return atob(data.content);
}

export default {
  async fetch(request, env) {
    try {
      const update = await request.json();

      if (!update.message?.text) {
        return new Response("OK");
      }

      const chatId = update.message.chat.id;
      const text = update.message.text.trim().toLowerCase();

      // ===================
      // CEK REPO
      // ===================

      if (text === "cek repo") {
        const project = await fetch(
          `https://gitlab.com/api/v4/projects/${env.GITLAB_PROJECT_ID}`,
          {
            headers: {
              "PRIVATE-TOKEN": env.GITLAB_TOKEN
            }
          }
        );

        const data = await project.json();

        await sendTelegram(
          env,
          chatId,
          `Project: ${data.name}
Branch: ${data.default_branch}
Visibility: ${data.visibility}`
        );

        return new Response("OK");
      }

      // ===================
      // LIST FILE
      // ===================

      if (text === "list file") {
        const tree = await getRepoTree(env);

        const files = tree
          .filter(x => x.type === "blob")
          .slice(0, 100)
          .map(x => x.path)
          .join("\n");

        await sendTelegram(
          env,
          chatId,
          files || "Tidak ada file."
        );

        return new Response("OK");
      }

      // ===================
      // CARI FILE
      // ===================

      if (text.startsWith("cari file ")) {
        const keyword = text.replace("cari file ", "");

        const tree = await getRepoTree(env);

        const matches = tree
          .filter(
            x =>
              x.type === "blob" &&
              x.path.toLowerCase().includes(keyword)
          )
          .slice(0, 30)
          .map(x => x.path);

        await sendTelegram(
          env,
          chatId,
          matches.length
            ? matches.join("\n")
            : "Tidak ditemukan."
        );

        return new Response("OK");
      }

      // ===================
      // BACA HOMEPAGE
      // ===================

      if (text === "baca homepage") {
        const candidates = [
          "app/page.js",
          "app/page.jsx",
          "src/app/page.js",
          "src/app/page.jsx"
        ];

        for (const file of candidates) {
          const content = await readGitlabFile(env, file);

          if (content) {
            await sendTelegram(
              env,
              chatId,
              `HOMEPAGE\n\n${content.slice(0, 3500)}`
            );

            return new Response("OK");
          }
        }

        await sendTelegram(
          env,
          chatId,
          "Homepage tidak ditemukan."
        );

        return new Response("OK");
      }

      // ===================
      // BACA FILE
      // ===================

      if (text.startsWith("baca file ")) {
        const path = update.message.text
          .trim()
          .substring(10);

        const content = await readGitlabFile(env, path);

        if (!content) {
          await sendTelegram(
            env,
            chatId,
            "File tidak ditemukan."
          );

          return new Response("OK");
        }

        await sendTelegram(
          env,
          chatId,
          content.slice(0, 3500)
        );

        return new Response("OK");
      }

      // ===================
      // FALLBACK AI
      // ===================

      const ai = await fetch(
        "https://gateway.dahono.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.DAHONO_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "dahono/qwen-coder-plus",
            messages: [
              {
                role: "user",
                content: update.message.text
              }
            ]
          })
        }
      );

      const data = await ai.json();

      const answer =
        data?.choices?.[0]?.message?.content ||
        "Tidak ada jawaban.";

      await sendTelegram(env, chatId, answer);

      return new Response("OK");
    } catch (err) {
      return new Response(
        "ERROR: " + err.message,
        { status: 500 }
      );
    }
  }
};        );

        return new Response("OK");
      }

      const data = await file.json();

      const content = atob(data.content);

      await sendTelegram(
        env,
        chatId,
        `FILE: ${path}\n\n${content.slice(0, 3500)}`
      );

      return new Response("OK");
    }

    // =========================
    // DAHONO AI
    // =========================

    const ai = await fetch(
      "https://gateway.dahono.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.DAHONO_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "dahono/qwen-coder-plus",
          messages: [
            {
              role: "user",
              content: text
            }
          ]
        })
      }
    );

    const data = await ai.json();

    const answer =
      data?.choices?.[0]?.message?.content ||
      "Tidak ada jawaban.";

    await sendTelegram(
      env,
      chatId,
      answer
    );

    return new Response("OK");
  }
};
