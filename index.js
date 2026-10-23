const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI, Type } = require('@google/genai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Load data files from repo root (or /data if nested)
const getFilePath = (filename) => {
  if (fs.existsSync(path.join(__dirname, filename))) return path.join(__dirname, filename);
  return path.join(__dirname, 'data', filename);
};

const charactersPath = getFilePath('characters.json');
const commonalitiesPath = getFilePath('commonalities.json');

const characters = JSON.parse(fs.readFileSync(charactersPath, 'utf8'));
let commonalities = JSON.parse(fs.readFileSync(commonalitiesPath, 'utf8'));

// 2. Compress character names & build a fast local lookup map for origins
const originLookup = new Map();
characters.forEach((c) => originLookup.set(c.name.toLowerCase(), c.origin));
const compressedCharacterNames = characters.map((c) => c.name).join(', ');

// Static System Instruction (Cached by the API to save tokens across rounds)
const SYSTEM_INSTRUCTION = `You are the dealer for a non-anime pop-culture character guessing game.
PREFERRED CHARACTER BANK:
${compressedCharacterNames}

RULES:
1. First, select every character from the PREFERRED CHARACTER BANK that genuinely fits the user's commonality.
2. If you need more characters to reach the requested count, generate additional well-known NON-ANIME characters (movies, TV, video games, cartoons, books, mascots, celebrities) that fit the commonality.
3. Never include two characters portrayed by the same real-world actor, and include at most 2 characters from the same franchise.
4. Keep each "reason" explanation under 12 words.`;

// Fisher-Yates shuffle helper
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Endpoint 1: Zero-token random commonality picker
app.get('/api/trait', (req, res) => {
  const randomTrait = commonalities[Math.floor(Math.random() * commonalities.length)];
  res.json(randomTrait);
});

// Endpoint 2: Deal cards for N players (Single AI call per round)
app.post('/api/deal', async (req, res) => {
  try {
    const { trait, playerCount = 2, saveCustom = false } = req.body;
    const count = Math.max(2, Math.min(8, Number(playerCount)));

    // Optionally save a custom trait to commonalities.json
    if (saveCustom && trait) {
      const exists = commonalities.some((c) => c.trait.toLowerCase() === trait.toLowerCase());
      if (!exists) {
        const newEntry = { id: commonalities.length + 1, trait: trait.trim() };
        commonalities.push(newEntry);
        fs.writeFileSync(commonalitiesPath, JSON.stringify(commonalities, null, 2));
      }
    }

    const mainstreamNeeded = count * 3;
    const challengingNeeded = count * 2;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Commonality: "${trait}"\nProvide ${mainstreamNeeded} mainstream characters and ${challengingNeeded} challenging characters (${count * 5} unique total).`,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mainstream: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  origin: { type: Type.STRING },
                  reason: { type: Type.STRING }
                },
                required: ['name', 'origin', 'reason']
              }
            },
            challenging: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  origin: { type: Type.STRING },
                  reason: { type: Type.STRING }
                },
                required: ['name', 'origin', 'reason']
              }
            }
          },
          required: ['mainstream', 'challenging']
        }
      }
    });

    const data = JSON.parse(response.text);

    // Enrich with canonical origin from characters.json if available
    const enrich = (item, tier) => ({
      name: item.name,
      origin: originLookup.get(item.name.toLowerCase()) || item.origin,
      reason: item.reason,
      tier
    });

    const mainPool = shuffle((data.mainstream || []).map((c) => enrich(c, 'Mainstream')));
    const chalPool = shuffle((data.challenging || []).map((c) => enrich(c, 'Challenging')));

    // Deal 3 Mainstream + 2 Challenging per player
    const hands = [];
    for (let i = 0; i < count; i++) {
      const playerHand = [
        ...mainPool.slice(i * 3, i * 3 + 3),
        ...chalPool.slice(i * 2, i * 2 + 2)
      ];
      hands.push(playerHand);
    }

    res.json({ trait, playerCount: count, hands });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate round. Check your API key in Replit Secrets.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jest Guessing running on port ${PORT}`));