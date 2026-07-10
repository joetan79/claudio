async function callAnthropic({ apiKey, model, system, messages }) {
  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    ...(system ? { system } : {}),
    messages,
  });

  let response;
  const retryDelays = [3000, 8000, 15000];
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const delay = retryDelays[attempt - 1] ?? 15000;
      console.warn(`[ai] Anthropic overloaded, retry ${attempt}/3 in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    });
    if (response.status !== 529) break;
  }

  if (!response.ok) {
    const err = await response.text();
    throw Object.assign(new Error(`Anthropic API error: ${response.status} ${err}`), { status: response.status });
  }

  const data = await response.json();
  return {
    text: data.content?.[0]?.text ?? '',
    usage: {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
    },
  };
}

async function callOpenRouter({ apiKey, model, system, messages }) {
  const orMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages: orMessages }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw Object.assign(new Error(`OpenRouter API error: ${response.status} ${err}`), { status: response.status });
  }

  const data = await response.json();
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

export async function aiComplete({ provider, model, apiKey, system, messages }) {
  if (provider === 'openrouter') return callOpenRouter({ apiKey, model, system, messages });
  return callAnthropic({ apiKey, model, system, messages });
}
