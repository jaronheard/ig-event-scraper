import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import sharp from "sharp";
import Store from "electron-store";

const store = new Store();

function getOpenRouterClient() {
  const apiKey = store.get("openrouterApiKey", process.env.OPENROUTER_API_KEY) as string | undefined;
  if (!apiKey) {
    throw new Error("No OpenRouter API key configured. Set it in Settings.");
  }
  return createOpenRouter({ apiKey });
}

const PROMPT = `Is this Instagram story promoting a real event with a specific time and place - like a concert, party, gathering, show, or hangout?

Answer NO if:
- It's a sponsored post or advertisement
- It's just a product promotion
- There's no specific date, time, or location mentioned

Answer YES only if it's promoting an actual event someone could attend.

Reply with only YES or NO.`;

export async function isEventPromotion(imagePath: string): Promise<boolean> {
  const optimizedBuffer = await sharp(imagePath)
    .resize(640)
    .webp({ quality: 50 })
    .toBuffer();

  const base64Image = optimizedBuffer.toString("base64");

  const openrouter = getOpenRouterClient();
  const { text } = await generateText({
    model: openrouter("google/gemini-2.5-flash-lite"),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          {
            type: "image",
            image: `data:image/webp;base64,${base64Image}`,
          },
        ],
      },
    ],
  });

  return text.trim().toUpperCase().startsWith("YES");
}
