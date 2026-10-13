import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.GEMINI_API_KEY;
// Modelo actual con soporte de grounding (búsqueda web)
const MODEL = 'gemini-3.8-flash'; 

if (!API_KEY) {
  console.warn('⚠️  Falta GEMINI_API_KEY en las variables de entorno');
}

app.post('/api/card-info', async (req, res) => {
  const query = (req.body?.query || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Falta el nombre de la tarjeta' });
  }

  const prompt = `Eres un analista financiero experto en tarjetas de crédito en México.
Con tu conocimiento general, proporciona una estimación del CAT y el pago mínimo para: "${query}".
Si no estás seguro, usa 5.0 para el pago mínimo.
Responde solo con JSON: {"cat": 85.1, "pago_minimo": 5.0, "nombre": "Banco - Tarjeta"}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }], // 🔍 Grounding con Búsqueda de Google
        generationConfig: { temperature: 0.2 }
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Gemini error:', JSON.stringify(result));
      return res.status(502).json({ error: result?.error?.message || 'Error de Gemini' });
    }

    // Con grounding, el texto puede venir en varias "parts"
    const parts = result?.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map(p => p.text).filter(Boolean).join('\n');

    // Extraer el primer objeto JSON que aparezca
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('Respuesta sin JSON:', rawText);
      return res.status(502).json({ error: 'La IA no devolvió datos estructurados' });
    }

    const data = JSON.parse(match[0]);

    // Validación y normalización
    const cat = Number(data.cat);
    const pagoMinimo = Number(data.pago_minimo);

    if (!Number.isFinite(cat) || cat <= 0) {
      return res.status(502).json({ error: 'CAT inválido en la respuesta' });
    }

    res.json({
      cat: Math.round(cat * 10) / 10,
      pago_minimo: Number.isFinite(pagoMinimo) && pagoMinimo > 0 ? pagoMinimo : 5.0,
      nombre: String(data.nombre || query)
    });

  } catch (err) {
    console.error('Error servidor:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor en http://localhost:${PORT}`));
