async function sendTelegram(env, chatId, text) {
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000)
      })
    }
  );
}

export default {
  async fetch(request, env) {
    const update = await request.json();

    if (!update.message?.text) {
      return new Response("OK");
    }

    const chatId = update.message.chat.id;
    const text = update.message.text.trim();

    // =========================
    // CEK REPO
    // =========================

    if (text.toLowerCase() === "cek repo") {
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
        `Project: ${data.name}\n` +
        `Branch: ${data.default_branch}\n` +
        `Visibility: ${data.visibility}`
      );

      return new Response("OK");
    }

    // =========================
    // LIST FILE
    // =========================

    if (text.toLowerCase() === "list file") {
      const tree = await fetch(
        `https://gitlab.com/api/v4/projects/${env.GITLAB_PROJECT_ID}/repository/tree?recursive=true&per_page=100`,
        {
          headers: {
            "PRIVATE-TOKEN": env.GITLAB_TOKEN
          }
        }
      );

      const files = await tree.json();

      const result = files
        .filter(item => item.type === "blob")
        .slice(0, 100)
        .map(item => item.path)
        .join("\n");

      await sendTelegram(
        env,
        chatId,
        "100 file pertama:\n\n" + result
      );

      return new Response("OK");
    }

    // =========================
    // BACA FILE
    // =========================

    if (text.toLowerCase().startsWith("baca file ")) {
      const path = text.substring(10).trim();

      const file = await fetch(
        `https://gitlab.com/api/v4/projects/${env.GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(path)}?ref=main`,
        {
          headers: {
            "PRIVATE-TOKEN": env.GITLAB_TOKEN
          }
        }
      );

      if (!file.ok) {
        await sendTelegram(
          env,
          chatId,
          "File tidak ditemukan."
        );

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
