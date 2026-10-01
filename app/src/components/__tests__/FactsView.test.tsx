import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import FactsView from "../FactsView";
import { ApiError, Fact, FactList, api } from "../../api";

/**
 * Facts: what the assistant has on file, what it would like to add, and a way
 * to tell it something.
 *
 * What matters is that nothing is drawn as done before the server says so — a
 * kept fact that was not, a forgotten one still in the prompt — and that the
 * one irreversible button asks first.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listFacts: jest.fn(),
    addFact: jest.fn(),
    decideFact: jest.fn(),
    forgetFact: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const fact = (id: number, extra: Partial<Fact> = {}): Fact => ({
  id,
  category: "food",
  key: `key${id}`,
  value: `value ${id}`,
  confidence: "stated",
  source: "manual",
  status: "active",
  conversation_id: null,
  learned_at: "2026-09-18T02:00:00+00:00",
  decided_at: "2026-09-18T02:00:00+00:00",
  ...extra,
});

const proposal = (id: number, replaces: string | null = null, extra: Partial<Fact> = {}) => ({
  ...fact(id, { status: "proposed", source: "extracted", confidence: "inferred", decided_at: null, ...extra }),
  replaces,
});

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status }) as ApiError;

const list = (active: Fact[], proposed: FactList["proposed"] = []): FactList => ({ active, proposed });

beforeEach(() => {
  // Reset, not clear: a queued `Once` answer must not leak into the next test.
  jest.resetAllMocks();
  mockApi.listFacts.mockResolvedValue(list([]));
  mockApi.addFact.mockResolvedValue(fact(99));
  mockApi.decideFact.mockResolvedValue(fact(1));
  mockApi.forgetFact.mockResolvedValue({ forgotten: 1 });
});

it("reads on arrival and not before", async () => {
  const view = render(<FactsView active={false} />);
  expect(mockApi.listFacts).not.toHaveBeenCalled();

  view.rerender(<FactsView active />);
  await screen.findByText(/Nothing on file yet/);
  expect(mockApi.listFacts).toHaveBeenCalledTimes(1);
});

it("says plainly when there is nothing to review and nothing on file", async () => {
  render(<FactsView active />);

  expect(await screen.findByText(/Nothing to review/)).toBeTruthy();
  expect(screen.getByText(/Nothing on file yet/)).toBeTruthy();
  expect(within(screen.getByTestId("facts-proposed")).getByText("nothing waiting")).toBeTruthy();
  expect(screen.queryByTestId("facts-keep-all")).toBeNull();
});

it("groups what it knows by category, with each fact's date, source and confidence", async () => {
  mockApi.listFacts.mockResolvedValue(
    list([
      fact(1, { key: "coffee", value: "Black, no sugar." }),
      fact(2, { key: "pork", value: "Doesn't eat it.", source: "chat", confidence: "inferred" }),
      fact(3, { category: "work", key: "employer", value: "Acme" }),
    ]),
  );
  render(<FactsView active />);

  const food = within(await screen.findByTestId("facts-category-food"));
  expect(food.getByText("coffee: Black, no sugar.")).toBeTruthy();
  expect(food.getByText(/from chat · inferred/)).toBeTruthy();
  expect(within(screen.getByTestId("facts-category-work")).getByText("employer: Acme")).toBeTruthy();
  expect(within(screen.getByTestId("facts-known")).getByText("3 on file")).toBeTruthy();
});

it("shows a replacement beside what it would replace", async () => {
  mockApi.listFacts.mockResolvedValue(list([fact(1, { key: "coffee", value: "Black" })], [proposal(5, "Black", { key: "coffee", value: "Oat milk" })]));
  render(<FactsView active />);

  expect(await screen.findByTestId("facts-proposed-5-replaces")).toHaveTextContent("replaces “Black”");
  expect(within(screen.getByTestId("facts-proposed")).getByText("1 waiting")).toBeTruthy();
});

it("keeps and rejects by waiting for the answer and reading again", async () => {
  mockApi.listFacts.mockResolvedValueOnce(list([], [proposal(5), proposal(6)]));
  render(<FactsView active />);

  let answer!: (f: Fact) => void;
  mockApi.decideFact.mockReturnValueOnce(new Promise((r) => (answer = r)));
  mockApi.listFacts.mockResolvedValueOnce(list([fact(5)], [proposal(6)]));

  fireEvent.press(await screen.findByTestId("facts-keep-5"));

  // Not optimistic: still waiting, and every button waits with it.
  expect(screen.getByTestId("facts-proposed-5")).toBeTruthy();
  expect(screen.getByTestId("facts-reject-6")).toBeDisabled();
  expect(mockApi.decideFact).toHaveBeenCalledWith(5, "keep");

  answer(fact(5));
  await screen.findByTestId("facts-known-5");
  expect(screen.queryByTestId("facts-proposed-5")).toBeNull();
  await waitFor(() => expect(screen.getByTestId("facts-reject-6")).not.toBeDisabled());

  mockApi.listFacts.mockResolvedValueOnce(list([fact(5)]));
  fireEvent.press(screen.getByTestId("facts-reject-6"));
  await waitFor(() => expect(screen.queryByTestId("facts-proposed-6")).toBeNull());
  expect(mockApi.decideFact).toHaveBeenLastCalledWith(6, "reject");
});

it("shows a 409 on the review card and redraws from the server", async () => {
  mockApi.listFacts.mockResolvedValueOnce(list([], [proposal(5)]));
  mockApi.decideFact.mockRejectedValueOnce(apiError(409, "That fact has already been decided."));
  // Another tab rejected it, so the re-read has nothing waiting.
  mockApi.listFacts.mockResolvedValueOnce(list([]));
  render(<FactsView active />);

  fireEvent.press(await screen.findByTestId("facts-keep-5"));

  expect(await within(screen.getByTestId("facts-proposed")).findByText("That fact has already been decided.")).toBeTruthy();
  expect(screen.queryByTestId("facts-proposed-5")).toBeNull();
});

it("keeps all, oldest first, so the newer of two for one key ends on file", async () => {
  mockApi.listFacts.mockResolvedValueOnce(list([], [proposal(7), proposal(6)]));
  render(<FactsView active />);

  fireEvent.press(await screen.findByTestId("facts-keep-all"));

  await waitFor(() => expect(mockApi.decideFact).toHaveBeenCalledTimes(2));
  expect(mockApi.decideFact.mock.calls).toEqual([
    [6, "keep"],
    [7, "keep"],
  ]);
});

it("asks before forgetting, and forgets nothing on Cancel", async () => {
  mockApi.listFacts.mockResolvedValue(list([fact(1, { key: "coffee" })]));
  render(<FactsView active />);

  fireEvent.press(await screen.findByTestId("facts-forget-1"));
  expect(screen.getByText("Forget food / coffee?")).toBeTruthy();

  fireEvent.press(screen.getByText("Cancel"));
  expect(mockApi.forgetFact).not.toHaveBeenCalled();

  fireEvent.press(screen.getByTestId("facts-forget-1"));
  mockApi.listFacts.mockResolvedValue(list([]));
  // The dialog's button, drawn after the row's own.
  fireEvent.press(screen.getAllByText("Forget").at(-1)!);

  await waitFor(() => expect(screen.queryByTestId("facts-known-1")).toBeNull());
  expect(mockApi.forgetFact).toHaveBeenCalledWith(1);
});

it("adds a fact from the three fields, and keeps the words when it is refused", async () => {
  render(<FactsView active />);
  await screen.findByText(/Nothing on file yet/);

  const submit = screen.getByTestId("facts-add-submit");
  expect(submit).toBeDisabled();

  fireEvent.changeText(screen.getByLabelText("Category"), "food");
  fireEvent.changeText(screen.getByLabelText("Key"), "coffee");
  fireEvent.changeText(screen.getByLabelText("Value"), "x".repeat(400));

  mockApi.addFact.mockRejectedValueOnce(apiError(422, "The value field must not be greater than 300 characters."));
  fireEvent.press(submit);

  expect(await within(screen.getByTestId("facts-add")).findByText(/not be greater than 300/)).toBeTruthy();
  expect(screen.getByLabelText("Value").props.value).toBe("x".repeat(400));

  fireEvent.changeText(screen.getByLabelText("Value"), "Black, no sugar.");
  mockApi.listFacts.mockResolvedValue(list([fact(1, { key: "coffee", value: "Black, no sugar." })]));
  fireEvent.press(submit);

  await screen.findByTestId("facts-known-1");
  expect(mockApi.addFact).toHaveBeenLastCalledWith({ category: "food", key: "coffee", value: "Black, no sugar." });
  // The category stays for the next one; the subject and the claim clear.
  expect(screen.getByLabelText("Category").props.value).toBe("food");
  expect(screen.getByLabelText("Value").props.value).toBe("");
});
