import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import NewsView from "../NewsView";
import { ApiError, NewsItem, NewsPage, PinnedArticle, api } from "../../api";

/**
 * News: one list under a row of beat chips, and a pin for later.
 *
 * What matters is that a chip reads its own beat and only its own — an answer
 * for the chip just left must never land over the one just picked — that a pin
 * is drawn from the server's answer rather than the press, and that an empty
 * list says which of its three reasons it is.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    getNews: jest.fn(),
    pinArticle: jest.fn(),
    unpinArticle: jest.fn(),
    getNewsSettings: jest.fn(),
    updateNewsSettings: jest.fn(),
    listPins: jest.fn(),
    markPinRead: jest.fn(),
    reopenPin: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const BEATS: NewsPage["beats"] = [
  { key: "local", label: "Metro Manila" },
  { key: "tech", label: "Tech" },
  { key: "interests", label: "Your interests" },
];

const item = (id: string, extra: Partial<NewsItem> = {}): NewsItem => ({
  id,
  title: `Story ${id}`,
  link: `https://example.com/${id}`,
  source: "Inquirer",
  published_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  summary: `Summary of ${id}.`,
  pinned: false,
  pin_id: null,
  ...extra,
});

const page = (beat: string, items: NewsItem[], extra: Partial<NewsPage> = {}): NewsPage => ({
  beat,
  label: BEATS.find((b) => b.key === beat)?.label ?? beat,
  items,
  unreachable: [],
  beats: BEATS,
  ...extra,
});

const pin = (id: number, itemId: string): PinnedArticle => ({
  id,
  item_id: itemId,
  title: `Story ${itemId}`,
  source: "Inquirer",
  link: `https://example.com/${itemId}`,
  summary: null,
  published_at: null,
  read_at: null,
  created_at: null,
  updated_at: null,
});

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status }) as ApiError;

/** The HUD's half: it holds the beat, so a close keeps it. */
function Harness({ active = true, initial = null }: { active?: boolean; initial?: string | null }) {
  const [beat, setBeat] = useState<string | null>(initial);
  return <NewsView active={active} beat={beat} onBeat={setBeat} />;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockApi.getNews.mockImplementation(async (beat) => page(beat ?? "local", [item("aaaaaaaaaaa1"), item("aaaaaaaaaaa2")]));
  mockApi.pinArticle.mockResolvedValue(pin(7, "aaaaaaaaaaa1"));
  mockApi.unpinArticle.mockResolvedValue(undefined);
  mockApi.getNewsSettings.mockResolvedValue({ interests: [], max: 10, max_chars: 60 });
  mockApi.updateNewsSettings.mockResolvedValue({ interests: [], max: 10, max_chars: 60 });
  mockApi.listPins.mockResolvedValue({ data: [], unread: 0 });
  mockApi.markPinRead.mockResolvedValue(pin(1, "x"));
  mockApi.reopenPin.mockResolvedValue(pin(1, "x"));
});

it("reads nothing until it is open, then the server's first beat", async () => {
  const view = render(<Harness active={false} />);
  expect(mockApi.getNews).not.toHaveBeenCalled();

  view.rerender(<Harness active />);
  await screen.findByText("Story aaaaaaaaaaa1");
  expect(mockApi.getNews).toHaveBeenCalledWith(null);
});

it("draws the chips from the server, Interests last, and each story's source and age", async () => {
  render(<Harness />);
  await screen.findByText("Story aaaaaaaaaaa1");

  const chips = within(screen.getByTestId("news-beats"));
  expect(chips.getByText("Metro Manila")).toBeTruthy();
  expect(chips.getByText("Tech")).toBeTruthy();
  expect(chips.getByText("Interests")).toBeTruthy();
  expect(chips.getByText("Metro Manila").parent?.parent?.props.accessibilityState).toEqual({ selected: true });

  const story = within(screen.getByTestId("news-item-aaaaaaaaaaa1"));
  expect(story.getByText("Inquirer · 3h ago")).toBeTruthy();
  expect(story.getByText("Summary of aaaaaaaaaaa1.")).toBeTruthy();
  expect(within(screen.getByTestId("news-list")).getByText("2 stories")).toBeTruthy();
});

it("reads the picked beat, and keeps the chips up while it does", async () => {
  render(<Harness />);
  await screen.findByText("Story aaaaaaaaaaa1");

  let answer!: (p: NewsPage) => void;
  mockApi.getNews.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  fireEvent.press(within(screen.getByTestId("news-beats")).getByText("Tech"));

  expect(mockApi.getNews).toHaveBeenLastCalledWith("tech");
  expect(screen.getByTestId("news-beats")).toBeTruthy();
  expect(screen.queryByText("Story aaaaaaaaaaa1")).toBeNull();

  await act(async () => answer(page("tech", [item("bbbbbbbbbbb1", { source: "The Verge" })])));
  expect(screen.getByText("Story bbbbbbbbbbb1")).toBeTruthy();
  expect(within(screen.getByTestId("news-list")).getByText("Tech")).toBeTruthy();
});

it("never draws a late answer for the chip just left over the one just picked", async () => {
  let late!: (p: NewsPage) => void;
  mockApi.getNews.mockImplementationOnce(async () => page("local", [item("aaaaaaaaaaa1")]));
  render(<Harness />);
  await screen.findByText("Story aaaaaaaaaaa1");

  // Tech is slow; Local, picked again, is quick. Tech's answer lands last.
  mockApi.getNews.mockImplementationOnce(() => new Promise((resolve) => (late = resolve)));
  fireEvent.press(within(screen.getByTestId("news-beats")).getByText("Tech"));
  fireEvent.press(within(screen.getByTestId("news-beats")).getByText("Metro Manila"));
  await screen.findByText("Story aaaaaaaaaaa1");

  await act(async () => late(page("tech", [item("bbbbbbbbbbb1")])));
  expect(screen.queryByText("Story bbbbbbbbbbb1")).toBeNull();
  expect(screen.getByText("Story aaaaaaaaaaa1")).toBeTruthy();
});

it("pins by the story's id and draws Pinned from the answer, then unpins by the pin's id", async () => {
  let answer!: (p: PinnedArticle) => void;
  mockApi.pinArticle.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  render(<Harness />);
  await screen.findByText("Story aaaaaaaaaaa1");

  fireEvent.press(screen.getByTestId("news-pin-aaaaaaaaaaa1"));
  expect(mockApi.pinArticle).toHaveBeenCalledWith("aaaaaaaaaaa1");
  // Not optimistic, and one write at a time.
  expect(within(screen.getByTestId("news-pin-aaaaaaaaaaa1")).queryByText("Pinned")).toBeNull();
  expect(screen.getByTestId("news-pin-aaaaaaaaaaa2").props.accessibilityState.disabled).toBe(true);

  await act(async () => answer(pin(7, "aaaaaaaaaaa1")));
  expect(within(screen.getByTestId("news-pin-aaaaaaaaaaa1")).getByText("Pinned")).toBeTruthy();
  expect(screen.getByLabelText("Unpin Story aaaaaaaaaaa1")).toBeTruthy();

  fireEvent.press(screen.getByTestId("news-pin-aaaaaaaaaaa1"));
  await waitFor(() => expect(mockApi.unpinArticle).toHaveBeenCalledWith(7));
  await waitFor(() => expect(within(screen.getByTestId("news-pin-aaaaaaaaaaa1")).getByText("Pin")).toBeTruthy());
});

it("unpins a story the server already had pinned, by the pin_id it sent", async () => {
  mockApi.getNews.mockResolvedValue(page("local", [item("aaaaaaaaaaa1", { pinned: true, pin_id: 12 })]));
  render(<Harness />);
  await waitFor(() => expect(within(screen.getByTestId("news-pin-aaaaaaaaaaa1")).getByText("Pinned")).toBeTruthy());

  fireEvent.press(screen.getByTestId("news-pin-aaaaaaaaaaa1"));
  await waitFor(() => expect(mockApi.unpinArticle).toHaveBeenCalledWith(12));
  expect(mockApi.pinArticle).not.toHaveBeenCalled();
});

it("says why a pin was refused, and reads the beat again", async () => {
  mockApi.pinArticle.mockRejectedValueOnce(apiError(422, "That story is no longer held — read the news again."));
  render(<Harness />);
  await screen.findByText("Story aaaaaaaaaaa1");
  const reads = mockApi.getNews.mock.calls.length;

  fireEvent.press(screen.getByTestId("news-pin-aaaaaaaaaaa1"));
  expect(await screen.findByText("That story is no longer held — read the news again.")).toBeTruthy();
  expect(within(screen.getByTestId("news-pin-aaaaaaaaaaa1")).getByText("Pin")).toBeTruthy();
  await waitFor(() => expect(mockApi.getNews.mock.calls.length).toBeGreaterThan(reads));
});

it("opens a story in a new tab, by its link", async () => {
  const open = jest.spyOn(window, "open").mockImplementation(() => null);
  render(<Harness />);
  await screen.findByText("Story aaaaaaaaaaa1");

  fireEvent.press(screen.getByLabelText("Open Story aaaaaaaaaaa1"));
  expect(open).toHaveBeenCalledWith("https://example.com/aaaaaaaaaaa1", "_blank", "noopener");
  open.mockRestore();
});

it("names the outlets it could not reach, in amber under the list", async () => {
  mockApi.getNews.mockResolvedValue(
    page("local", [item("aaaaaaaaaaa1")], {
      unreachable: [
        { source: "GMA Metro", message: "timed out" },
        { source: "Rappler", message: "refused" },
      ],
    }),
  );
  render(<Harness />);

  expect(await screen.findByText(/Couldn't reach GMA Metro, Rappler — their stories are missing/)).toBeTruthy();
});

describe("an empty list says which kind of empty", () => {
  it("no interests set points at the editor above it", async () => {
    mockApi.getNews.mockResolvedValue(page("interests", [], { searched: [] }));
    render(<Harness initial="interests" />);

    expect(await screen.findByTestId("news-empty-interests")).toHaveTextContent(/Add them above/);
    expect(within(screen.getByTestId("news-list")).queryByText("0 stories")).toBeNull();
  });

  it("nothing in the window", async () => {
    mockApi.getNews.mockResolvedValue(page("local", []));
    render(<Harness />);

    expect(await screen.findByText("Nothing new here in the last week.")).toBeTruthy();
  });

  it("every outlet unreachable", async () => {
    mockApi.getNews.mockResolvedValue(page("local", [], { unreachable: [{ source: "Inquirer", message: "down" }] }));
    render(<Harness />);

    expect(await screen.findByText(/Nothing could be read just now/)).toBeTruthy();
    expect(screen.getByText(/Couldn't reach Inquirer — its stories are missing/)).toBeTruthy();
  });
});

it("keeps the last list when a refresh fails, and says so", async () => {
  jest.useFakeTimers();
  try {
    render(<Harness />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Story aaaaaaaaaaa1")).toBeTruthy();

    mockApi.getNews.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      jest.advanceTimersByTime(600_000);
      await Promise.resolve();
    });

    expect(screen.getByText("Story aaaaaaaaaaa1")).toBeTruthy();
    expect(screen.getByText("Couldn't refresh — showing the last reading.")).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

describe("Interests (19.4)", () => {
  it("is edited on its own chip, and on no other", async () => {
    mockApi.getNewsSettings.mockResolvedValue({ interests: ["Formula 1"], max: 10, max_chars: 60 });
    render(<Harness />);
    const chips = await screen.findByTestId("news-beats");
    expect(screen.queryByTestId("news-interests")).toBeNull();

    await act(async () => {
      fireEvent.press(within(chips).getByText("Interests"));
    });
    await waitFor(() => expect(screen.getByTestId("news-interests-input").props.value).toBe("Formula 1"));
  });

  it("saves on blur, one per line, and reads the stories again", async () => {
    mockApi.getNewsSettings.mockResolvedValue({ interests: ["Formula 1"], max: 10, max_chars: 60 });
    mockApi.updateNewsSettings.mockResolvedValue({ interests: ["Formula 1", "Nintendo"], max: 10, max_chars: 60 });
    render(<Harness initial="interests" />);
    await waitFor(() => expect(screen.getByTestId("news-interests-input").props.value).toBe("Formula 1"));
    const reads = mockApi.getNews.mock.calls.length;

    fireEvent.changeText(screen.getByTestId("news-interests-input"), "Formula 1\n\n Nintendo \n");
    await act(async () => {
      fireEvent(screen.getByTestId("news-interests-input"), "blur");
    });

    expect(mockApi.updateNewsSettings).toHaveBeenCalledWith(["Formula 1", "Nintendo"]);
    await waitFor(() => expect(mockApi.getNews.mock.calls.length).toBeGreaterThan(reads));
    expect(mockApi.getNews).toHaveBeenLastCalledWith("interests");
    expect(screen.getByTestId("news-interests-input").props.value).toBe("Formula 1\nNintendo");
  });

  it("sends nothing when the list is what is stored", async () => {
    mockApi.getNewsSettings.mockResolvedValue({ interests: ["Formula 1"], max: 10, max_chars: 60 });
    render(<Harness initial="interests" />);
    await waitFor(() => expect(screen.getByTestId("news-interests-input").props.value).toBe("Formula 1"));

    fireEvent.changeText(screen.getByTestId("news-interests-input"), " Formula 1 \n");
    fireEvent(screen.getByTestId("news-interests-input"), "blur");

    expect(mockApi.updateNewsSettings).not.toHaveBeenCalled();
  });

  it("pulls a refused list back and says why", async () => {
    mockApi.getNewsSettings.mockResolvedValue({ interests: ["Formula 1"], max: 10, max_chars: 60 });
    mockApi.updateNewsSettings.mockRejectedValue(apiError(422, "Each interest is a topic of at most 60 characters."));
    render(<Harness initial="interests" />);
    await waitFor(() => expect(screen.getByTestId("news-interests-input").props.value).toBe("Formula 1"));

    fireEvent.changeText(screen.getByTestId("news-interests-input"), "x".repeat(61));
    await act(async () => {
      fireEvent(screen.getByTestId("news-interests-input"), "blur");
    });

    expect(await screen.findByText("Each interest is a topic of at most 60 characters.")).toBeTruthy();
    expect(screen.getByTestId("news-interests-input").props.value).toBe("Formula 1");
  });
});

describe("Pinned (19.4)", () => {
  const unread = { ...pin(1, "aaaaaaaaaaa1"), created_at: new Date().toISOString() };
  const read = { ...pin(2, "bbbbbbbbbbb2"), read_at: new Date().toISOString() };

  beforeEach(() => {
    mockApi.listPins.mockResolvedValue({ data: [unread, read], unread: 1 });
  });

  it("is a chip after the beats, and never asks the server for a beat called pinned", async () => {
    render(<Harness />);
    const chips = await screen.findByTestId("news-beats");

    await act(async () => {
      fireEvent.press(within(chips).getByText("Pinned"));
    });

    expect(await screen.findByTestId("news-pinned-1")).toBeTruthy();
    expect(screen.queryByTestId("news-list")).toBeNull();
    expect(mockApi.getNews).not.toHaveBeenCalledWith("pinned");
  });

  it("draws the chips when it is opened straight onto Pinned", async () => {
    render(<Harness initial="pinned" />);

    expect(await screen.findByTestId("news-pinned-1")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("news-beats")).toBeTruthy());
    expect(mockApi.getNews).toHaveBeenCalledWith();
  });

  it("keeps read pins behind a toggle, each with Reopen", async () => {
    render(<Harness initial="pinned" />);
    await screen.findByTestId("news-pinned-1");
    expect(screen.queryByTestId("news-pinned-2")).toBeNull();

    fireEvent.press(screen.getByTestId("news-pinned-toggle"));
    await act(async () => {
      fireEvent.press(screen.getByTestId("news-pinned-2-reopen"));
    });

    expect(mockApi.reopenPin).toHaveBeenCalledWith(2);
  });

  it("marks one read and draws it from the re-read", async () => {
    render(<Harness initial="pinned" />);
    await screen.findByTestId("news-pinned-1");
    mockApi.listPins.mockResolvedValue({ data: [{ ...unread, read_at: new Date().toISOString() }, read], unread: 0 });

    await act(async () => {
      fireEvent.press(screen.getByTestId("news-pinned-1-read"));
    });

    expect(mockApi.markPinRead).toHaveBeenCalledWith(1);
    expect(screen.queryByTestId("news-pinned-1")).toBeNull();
    expect(screen.getByTestId("news-pinned-empty")).toHaveTextContent("Everything pinned has been read.");
  });

  it("removes one without asking", async () => {
    render(<Harness initial="pinned" />);
    await screen.findByTestId("news-pinned-1");
    mockApi.listPins.mockResolvedValue({ data: [read], unread: 0 });

    await act(async () => {
      fireEvent.press(screen.getByTestId("news-pinned-1-remove"));
    });

    expect(mockApi.unpinArticle).toHaveBeenCalledWith(1);
    expect(screen.queryByTestId("news-pinned-1")).toBeNull();
  });

  it("holds every other write while one is out", async () => {
    let finish: () => void = () => {};
    mockApi.markPinRead.mockReturnValue(new Promise((resolve) => (finish = () => resolve(unread))));
    render(<Harness initial="pinned" />);
    await screen.findByTestId("news-pinned-1");

    act(() => {
      fireEvent.press(screen.getByTestId("news-pinned-1-read"));
    });
    expect(screen.getByTestId("news-pinned-1-remove")).toBeDisabled();

    await act(async () => finish());
    await waitFor(() => expect(screen.getByTestId("news-pinned-1-remove")).not.toBeDisabled());
  });

  it("says so when nothing is pinned", async () => {
    mockApi.listPins.mockResolvedValue({ data: [], unread: 0 });
    render(<Harness initial="pinned" />);

    expect(await screen.findByTestId("news-pinned-empty")).toHaveTextContent(/Nothing pinned/);
  });
});
