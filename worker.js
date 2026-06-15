export default {
  async fetch(request, env) {
    const update = await request.json();

    if (!update.message?.text) {
      return new Response("OK");
    }

    const chatId = update.message.chat.id;
    const text = update.message.text;

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

    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: answer.slice(0, 4000)
        })
      }
    );

    return new Response("OK");
  }
};
