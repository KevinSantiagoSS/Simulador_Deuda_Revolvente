import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// Caché en memoria para no gastar las 2500 búsquedas de golpe
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 horas

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hasGeminiKey: !!GEMINI_API_KEY,
    hasSerperKey: !!SERPER_API_KEY,
    cacheSize: cache.size
  });
});

app.post('/api/card-info', async (req, res) => {
  const query = (req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Falta el nombre de la tarjeta' });

  const cacheKey = query.toLowerCase();
  const cached = cache.get(cacheKey);

  if (cached && cached.expires > Date.now()) {
    console.log('✅ Caché hit:', query);
    return res.json(cached.data);
  }

  try {
    // 1. BUSCAMOS EN GOOGLE USANDO SERPER (Gratis)
    console.log('🔍 Buscando en Google (Serper):', query);
    const serperRes = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: `${query} tarjeta de credito CAT pago minimo Mexico` })
    });

    if (!serperRes.ok) {
      console.error('Error de Serper:', await serperRes.text());
      return res.status(502).json({ error: 'Error al buscar en Google' });
    }

    const serperData = await serperRes.json();
    
    // Extraemos los textos de los primeros 5 resultados
    let contextoWeb = '';
    if (serperData.organic && serperData.organic.length > 0) {
      serperData.organic.slice(0, 5).forEach(item => {
        contextoWeb += `Título: ${item.title}\nResumen: ${item.snippet}\n\n`;
      });
    } else {
      contextoWeb = "No se encontraron resultados en la web.";
    }

    // 2. LE PASAMOS EL CONTEXTO A GEMINI PARA QUE SAQUE EL JSON
    const prompt = `Eres un analista financiero experto en tarjetas de crédito en México.
Basándote ÚNICAMENTE en los siguientes resultados de búsqueda de Google, extrae el CAT y el pago mínimo para la tarjeta consultada.

Resultados de la web:
${contextoWeb}

Responde ÚNICAMENTE con un objeto JSON válido, sin markdown, con este formato:
{"cat": 85.1, "pago_minimo": 5.0, "nombre": "Banco - Tarjeta"}
Si no encuentras datos claros, asigna cat: 85.0 y pago_minimo: 5.0.`;

    // --- LÓGICA DE REINTENTO CON MÚLTIPLES MODELOS ---
    // Si un modelo falla, intenta con el siguiente
    const modelos = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-3.8-flash'];
    let geminiData = null;
    let ultimoError = null;

    for (const modelo of modelos) {
      try {
        console.log(`🧠 Probando con modelo: ${modelo}...`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`;
        
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1 }
          })
        });

        geminiData = await geminiRes.json();

        // Si la respuesta es OK, rompemos el bucle y usamos este modelo
        if (geminiRes.ok) {
          console.log(`✅ Modelo ${modelo} respondió correctamente.`);
          break; 
        }

        // Si es error 503 (saturado), guardamos el error y probamos el siguiente modelo
        if (geminiRes.status === 503) {
          console.warn(`⚠️ Modelo ${modelo} saturado. Probando el siguiente...`);
          ultimoError = geminiData;
          continue; 
        }

        // Si es otro tipo de error, lo lanzamos para que lo capture el catch principal
        ultimoError = geminiData;
        break;

      } catch (err) {
        console.error(`Error de red con modelo ${modelo}:`, err);
        ultimoError = err;
      }
    }

    if (!geminiData || !geminiData.candidates) {
      throw new Error(JSON.stringify(ultimoError) || 'Ningún modelo pudo procesar la solicitud');
    }

    // Extraemos el texto de la respuesta
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map(p => p.text).filter(Boolean).join('\n');
    const match = rawText.match(/\{[\s\S]*\}/);

    if (!match) {
      return res.status(502).json({ error: 'La IA no devolvió datos estructurados' });
    }

    const parsedData = JSON.parse(match[0]);
    
    const resultado = {
      cat: Number(parsedData.cat) || 85.0,
      pago_minimo: Number(parsedData.pago_minimo) || 5.0,
      nombre: String(parsedData.nombre || query),
      cached: false
    };

    // Guardar en caché
    cache.set(cacheKey, {
      data: { ...resultado, cached: true },
      expires: Date.now() + CACHE_TTL
    });

    console.log('✅ Datos obtenidos:', resultado);
    res.json(resultado);

  } catch (err) {
    console.error('Error general:', err);
    res.status(500).json({ error: 'Error interno del servidor al procesar la tarjeta' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor en puerto ${PORT}`));
