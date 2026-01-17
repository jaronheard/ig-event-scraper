import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import sharp from "sharp";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  },
});

const PROMPT = `Is this Instagram story promoting a real event with a specific time and place - like a concert, party, gathering, show, or hangout?

Answer NO if:
- It's a sponsored post or advertisement
- It's just a product promotion
- There's no specific date, time, or location mentioned

Answer YES only if it's promoting an actual event someone could attend.

Reply with only YES or NO.`;

export async function isEventPromotion(imagePath: string): Promise<boolean> {
  // Optimize image: resize to 640px width, convert to WebP at 50% quality
  const optimizedBuffer = await sharp(imagePath)
    .resize(640)
    .webp({ quality: 50 })
    .toBuffer();

  const base64Image = optimizedBuffer.toString("base64");

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
