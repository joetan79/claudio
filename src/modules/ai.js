// Structured-JSON tasks (like DJ decisions) don't need deep reasoning, so we
// dial effort down by default. Only sent to models confirmed to accept
// output_config.effort — Sonnet 4.5, Haiku 4.5, and dated/legacy ids reject
// it with a 400, so this must stay an allowlist, not a blocklist.
const ANTHROPIC_EFFORT = process.env.ANTHROPIC_EFFORT ?? 'low';
const EFFORT_CAPABLE_MODEL_RE = /^claude-(opus-4-[5-8]|sonnet-4-6|sonnet-5|fable-5|mythos-5)$/;

async function callAnthropic({ apiKey, model, system, messages }) {
  const useEffort = ANTHROPIC_EFFORT && ANTHROPIC_EFFORT !== 'off' && EFFORT_CAPABLE_MODEL_RE.test(model);
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    ...(system ? { system } : {}),
    ...(useEffort ? { output_config: { effort: ANTHROPIC_EFFORT } } : {}),
    messages,
  });

  const t0 = Date.now();
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
    console.log(`[timing] anthropic_call_ms=${Date.now() - t0} model=${model} effort=${useEffort ? ANTHROPIC_EFFORT : 'n/a'} status=${response.status}(error)`);
    throw Object.assign(new Error(`Anthropic API error: ${response.status} ${err}`), { status: response.status });
  }

  const data = await response.json();
  console.log(`[timing] anthropic_call_ms=${Date.now() - t0} model=${model} effort=${useEffort ? ANTHROPIC_EFFORT : 'n/a'} in_tok=${data.usage?.input_tokens ?? 0} out_tok=${data.usage?.output_tokens ?? 0} cache_creation=${data.usage?.cache_creation_input_tokens ?? 0} cache_read=${data.usage?.cache_read_input_tokens ?? 0}`);
  const textBlock = data.content?.find(b => b.type === 'text');
  return {
    text: textBlock?.text ?? '',
    usage: {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

async function callOpenRouter({ apiKey, model, system, messages }) {
  // `system` may be a plain string or an Anthropic-style content-block array
  // (with cache_control on the static block). OpenRouter forwards content
  // blocks as-is to Anthropic-backed models — cache_control passes through
  // and takes effect there; on non-Anthropic models the field is simply an
  // unrecognized extra property and is ignored, no error.
  const orMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages: orMessages, max_tokens: 4096 }),
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
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

export async function aiComplete({ provider, model, apiKey, system, messages }) {
  if (provider === 'openrouter') return callOpenRouter({ apiKey, model, system, messages });
  return callAnthropic({ apiKey, model, system, messages });
}
