import { ApiError, api, errorMessage } from "../api";
import { TOKEN_KEY, setUnauthorizedHandler } from "../auth";

/** Minimal stand-in for a fetch Response; only what handle()/throwHttpError read. */
function res(status: number, body: string, statusText = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

const validExercise = {
  name: "Incline Bench Press",
  primary_muscle: "Chest",
  exercise_type: "weight_reps" as const,
};

describe("API error handling", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  function mockFetch(response: Response) {
    global.fetch = jest.fn().mockResolvedValue(response) as any;
  }

  // ── Laravel validation errors ───────────────────────────────────────────────

  it("surfaces the first field message from a 422 instead of raw JSON", async () => {
    mockFetch(res(422, JSON.stringify({
      message: "The name has already been taken. (and 1 more error)",
      errors: { name: ["The name has already been taken."] },
    })));

    await expect(api.createExercise(validExercise))
      .rejects.toThrow("The name has already been taken.");
  });

  it("does not leak the JSON payload or the HTTP prefix into the message", async () => {
    mockFetch(res(422, JSON.stringify({
      message: "validation failed",
      errors: { name: ["The name has already been taken."] },
    })));

    const err = (await api.createExercise(validExercise).catch((e) => e)) as ApiError;

    expect(err.message).not.toContain("{");
    expect(err.message).not.toContain("errors");
    expect(err.message).not.toContain("HTTP 422");
  });

  it("attaches status and fieldErrors to the thrown error", async () => {
    mockFetch(res(422, JSON.stringify({
      message: "validation failed",
      errors: { name: ["Taken."], primary_muscle: ["Required."] },
    })));

    const err = (await api.createExercise(validExercise).catch((e) => e)) as ApiError;

    expect(err.status).toBe(422);
    expect(err.fieldErrors).toEqual({ name: ["Taken."], primary_muscle: ["Required."] });
  });

  // ── Fallbacks ───────────────────────────────────────────────────────────────

  it("falls back to `message` when there is no errors object", async () => {
    mockFetch(res(404, JSON.stringify({ message: "No query results for model [Exercise] 42." })));

    await expect(api.listExercises())
      .rejects.toThrow("No query results for model [Exercise] 42.");
  });

  it("falls back to `message` when errors values are not string arrays", async () => {
    mockFetch(res(422, JSON.stringify({ message: "Unprocessable.", errors: { name: "not an array" } })));

    await expect(api.listExercises()).rejects.toThrow("Unprocessable.");
  });

  it("keeps status and body for non-JSON responses", async () => {
    mockFetch(res(500, "<html><body>Server Error</body></html>"));

    const err = (await api.listExercises().catch((e) => e)) as ApiError;

    expect(err.message).toContain("HTTP 500");
    expect(err.message).toContain("Server Error");
    expect(err.status).toBe(500);
    expect(err.fieldErrors).toBeUndefined();
  });

  it("truncates a long non-JSON body so it cannot fill the banner", async () => {
    mockFetch(res(502, "x".repeat(5000)));

    const err = (await api.listExercises().catch((e) => e)) as ApiError;

    // "HTTP 502: " prefix plus at most 200 characters of body.
    expect(err.message.length).toBeLessThanOrEqual("HTTP 502: ".length + 200);
  });

  it("uses statusText when the body is empty", async () => {
    mockFetch(res(503, "", "Service Unavailable"));

    await expect(api.listExercises()).rejects.toThrow("HTTP 503: Service Unavailable");
  });

  // ── 204 endpoints ───────────────────────────────────────────────────────────

  it("resolves deletes on 204 without parsing a body", async () => {
    mockFetch(res(204, ""));

    await expect(api.deleteExercise(1)).resolves.toBeUndefined();
  });

  it("rejects deletes with the parsed message on failure", async () => {
    mockFetch(res(404, JSON.stringify({ message: "Not found." })));

    await expect(api.deleteExercise(999)).rejects.toThrow("Not found.");
  });

  // ── Success path still works ────────────────────────────────────────────────

  it("returns parsed JSON on success", async () => {
    mockFetch(res(200, JSON.stringify({ data: [{ id: 1, name: "Squat" }] })));

    await expect(api.listExercises()).resolves.toEqual({ data: [{ id: 1, name: "Squat" }] });
  });

  it("passes the search term through as an encoded query param", async () => {
    mockFetch(res(200, JSON.stringify({ data: [] })));

    await api.listExercises({ search: "bench press" });

    // URLSearchParams spells a space as "+", which is what the query-string
    // production of a URL means by it; PHP reads it back as a space.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/exercises?search=bench+press"),
      expect.anything(),
    );
  });

  it("passes filters and page controls through as query params", async () => {
    mockFetch(res(200, JSON.stringify({ data: [] })));

    await api.listExercises({ primary_muscle: "Legs", page: 2, per_page: 25 });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain("primary_muscle=Legs");
    expect(url).toContain("page=2");
    expect(url).toContain("per_page=25");
  });

  it("omits list options that are unset or blank", async () => {
    mockFetch(res(200, JSON.stringify({ data: [] })));

    // A cleared filter has to leave the URL alone, not send an empty value —
    // the screens key their loads on the request they build.
    await api.listExercises({ search: "", primary_muscle: undefined });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/exercises$/),
      expect.anything(),
    );
  });

  it("passes the workout limit through as a query param", async () => {
    mockFetch(res(200, JSON.stringify({ data: [], summary: {} })));

    await api.listWorkouts({ limit: 200 });

    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/workouts?limit=200"));
  });

  it("omits the query string when no workout limit is given", async () => {
    mockFetch(res(200, JSON.stringify({ data: [], summary: {} })));

    await api.listWorkouts();

    expect(global.fetch).toHaveBeenCalledWith(expect.not.stringContaining("?"));
  });
});

describe("errorMessage", () => {
  it("returns the message without the `Error:` prefix String() adds", () => {
    expect(errorMessage(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(String(new Error("Failed to fetch"))).toBe("Error: Failed to fetch");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("apiFetch", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    setUnauthorizedHandler(null);
  });

  it("puts the stored token on every request, beside the caller's own headers", async () => {
    window.localStorage.setItem(TOKEN_KEY, "7|secret");
    global.fetch = jest.fn().mockResolvedValue(res(200, "{}")) as any;

    await api.getFitnessSettings();

    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/settings/fitness"), {
      headers: { Accept: "application/json", Authorization: "Bearer 7|secret" },
    });
  });

  it("adds a header even to a call that passes no options", async () => {
    window.localStorage.setItem(TOKEN_KEY, "7|secret");
    global.fetch = jest.fn().mockResolvedValue(res(200, JSON.stringify({ data: [], summary: {} }))) as any;

    await api.listWorkouts();

    expect((global.fetch as jest.Mock).mock.calls[0][1]).toEqual({
      headers: { Authorization: "Bearer 7|secret" },
    });
  });

  it("tells the sign-in about a 401 and still rejects the call", async () => {
    window.localStorage.setItem(TOKEN_KEY, "7|revoked");
    const onUnauthorized = jest.fn();
    setUnauthorizedHandler(onUnauthorized);
    global.fetch = jest.fn().mockResolvedValue(res(401, JSON.stringify({ message: "Sign in first." }))) as any;

    await expect(api.getWeather()).rejects.toMatchObject({ status: 401, message: "Sign in first." });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not call a 403 a lost session", async () => {
    const onUnauthorized = jest.fn();
    setUnauthorizedHandler(onUnauthorized);
    global.fetch = jest.fn().mockResolvedValue(res(403, JSON.stringify({ message: "Not the owner's account." }))) as any;

    await expect(api.completeGoogleSignIn("c", "s")).rejects.toThrow("Not the owner's account.");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
