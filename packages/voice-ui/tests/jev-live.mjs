import { textToUiIr } from "../src/decision/jev.mjs";

const apiKey = process.env.TYPESAFE_API_KEY;

async function decide(state) {
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "jev-latest",
      state,
      questions: {
        live: {
          type: "noul",
          instructions: "Is this state describing a live consumer proof?",
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error("Jev provider call failed");
  }

  const value = await response.json();
  const answer = value?.answers?.live;
  if (
    typeof value?.model !== "string" ||
    answer?.type !== "noul" ||
    typeof answer?.noul !== "number" ||
    answer.noul < 0 ||
    answer.noul > 1
  ) {
    throw new Error("Jev response violated the typed Noul contract");
  }

  return value;
}

try {
  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY is required");
  }

  await textToUiIr("voice-ui Jev live consumer proof", decide);
  process.stdout.write("PASS\n");
} catch {
  process.stderr.write("FAIL\n");
  process.exitCode = 1;
}
