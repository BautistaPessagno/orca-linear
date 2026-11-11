// Stand-ins for Orca's host APIs and for Linear's GraphQL endpoint. Made-up data only.

export function fakeSecrets(initial = {}) {
  const values = { ...initial }
  return {
    values,
    get: async (key) => values[key] ?? null,
    set: async (key, value) => void (values[key] = value),
    delete: async (key) => void delete values[key]
  }
}

export function fakeStorage(initial = {}) {
  const values = { ...initial }
  return {
    values,
    get: async (key) => (key in values ? structuredClone(values[key]) : null),
    set: async (key, value) => void (values[key] = structuredClone(value)),
    delete: async (key) => void delete values[key],
    keys: async () => Object.keys(values)
  }
}

export function fakeSettings(values = {}) {
  return {
    values,
    get: async (key) => values[key],
    set: async (key, value) => void (values[key] = value),
    onDidChange: () => ({ dispose() {} })
  }
}

export function reply(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Map(Object.entries(headers)), text: async () => (body === undefined ? '' : JSON.stringify(body)) }
}

// api.linear.app stand-in. `answer({ query, variables, key })` returns a reply or `{ data }`.
export function fakeLinearApi(answer) {
  const requests = []
  const fetchImpl = async (url, init) => {
    const { query, variables } = JSON.parse(init.body)
    const request = { url, key: init.headers.authorization, query, variables }
    requests.push(request)
    const out = await answer(request)
    return out && typeof out.status === 'number' ? out : reply(200, out)
  }
  return { fetchImpl, requests }
}
