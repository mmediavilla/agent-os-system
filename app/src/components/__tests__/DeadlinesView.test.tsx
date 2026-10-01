import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import DeadlinesView, { daysBetween, dueLabel } from "../DeadlinesView";
import { localToday } from "../RecordsParts";
import { ApiError, Deadline, FiledDocument, api } from "../../api";

/**
 * Records → Deadlines.
 *
 * What matters: overdue is read off the browser's clock and drawn amber; the
 * completed ones sit behind a toggle; Done and Reopen are writes that wait for
 * their answer, never drawn ahead of it; a due date cannot be emptied; the link
 * to a document can be set and cleared; and only Delete asks first.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listDeadlines: jest.fn(),
    listDocuments: jest.fn(),
    createDeadline: jest.fn(),
    updateDeadline: jest.fn(),
    deleteDeadline: jest.fn(),
    completeDeadline: jest.fn(),
    reopenDeadline: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const TODAY = localToday();
const shift = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localToday(d);
};

const policy = (extra: Partial<FiledDocument> = {}): FiledDocument => ({
  id: 7,
  title: "Car policy",
  kind: "policy",
  issued_on: null,
  expires_on: null,
  notes: null,
  mime: "application/pdf",
  size_bytes: 1024,
  file_url: "https://projectmc.test/api/documents/7/file?signature=x",
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  ...extra,
});

const deadline = (extra: Partial<Deadline> = {}): Deadline => ({
  id: 1,
  title: "Renew car insurance",
  due_on: shift(10),
  kind: "renewal",
  document_id: null,
  document: null,
  notes: null,
  completed_at: null,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  ...extra,
});

const page = <T,>(data: T[]) => ({
  data,
  meta: { page: 1, per_page: null, total: data.length, last_page: 1 } as never,
});

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status }) as ApiError;

beforeEach(() => {
  jest.resetAllMocks();
  mockApi.listDeadlines.mockResolvedValue(page([deadline()]));
  mockApi.listDocuments.mockResolvedValue(page([policy()]));
  mockApi.createDeadline.mockResolvedValue(deadline({ id: 2 }));
  mockApi.updateDeadline.mockResolvedValue(deadline());
  mockApi.deleteDeadline.mockResolvedValue(undefined);
  mockApi.completeDeadline.mockResolvedValue(deadline());
  mockApi.reopenDeadline.mockResolvedValue(deadline());
});

it("reads on arrival and not before", async () => {
  const view = render(<DeadlinesView active={false} />);
  expect(mockApi.listDeadlines).not.toHaveBeenCalled();

  view.rerender(<DeadlinesView active />);
  expect(await screen.findByTestId("deadline-1")).toBeTruthy();
  expect(mockApi.listDeadlines).toHaveBeenCalledTimes(1);
});

it("says so when nothing is tracked, and still offers the add card", async () => {
  mockApi.listDeadlines.mockResolvedValue(page([]));
  render(<DeadlinesView active />);

  expect(await screen.findByTestId("deadlines-empty")).toBeTruthy();
  expect(screen.getByTestId("deadline-new")).toBeTruthy();
});

it("says why when the deadlines cannot be read", async () => {
  mockApi.listDeadlines.mockRejectedValue(apiError(500, "The database is locked."));
  render(<DeadlinesView active />);

  expect(await screen.findByText("The database is locked.")).toBeTruthy();
  expect(screen.queryByTestId("deadline-new")).toBeNull();
});

it("still draws the deadlines when the cabinet cannot be read, and keeps a linked document", async () => {
  mockApi.listDocuments.mockRejectedValue(apiError(500, "nope"));
  mockApi.listDeadlines.mockResolvedValue(page([deadline({ document_id: 7, document: policy() })]));
  render(<DeadlinesView active />);

  expect(within(await screen.findByTestId("deadline-1-document")).getByText("Car policy")).toBeTruthy();
  expect(screen.queryByTestId("deadlines-error")).toBeNull();
});

describe("an open deadline", () => {
  it("counts down in days, not in amber", async () => {
    render(<DeadlinesView active />);
    const card = within(await screen.findByTestId("deadline-1"));

    expect(card.getByText("in 10 days")).toBeTruthy();
    expect(screen.queryByTestId("deadline-1-overdue")).toBeNull();
  });

  it("is overdue in amber once its day has passed on this browser's clock", async () => {
    mockApi.listDeadlines.mockResolvedValue(page([deadline({ due_on: shift(-3) })]));
    render(<DeadlinesView active />);
    const card = within(await screen.findByTestId("deadline-1"));

    expect(card.getByText("overdue 3 days")).toBeTruthy();
    expect(within(screen.getByTestId("deadline-1-overdue")).getByText(`since ${shift(-3)}`)).toBeTruthy();
  });

  it("names the document it is about and opens its file through the signed URL", async () => {
    mockApi.listDeadlines.mockResolvedValue(page([deadline({ document_id: 7, document: policy() })]));
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    render(<DeadlinesView active />);

    fireEvent.press(await screen.findByLabelText("Open Car policy"));
    expect(open).toHaveBeenCalledWith(policy().file_url, "_blank", "noopener");
    open.mockRestore();
  });

  it("is marked done by a write, and redraws from the re-read rather than ahead of it", async () => {
    let finish!: (d: Deadline) => void;
    mockApi.completeDeadline.mockReturnValue(new Promise((r) => (finish = r)));
    render(<DeadlinesView active />);

    fireEvent.press(await screen.findByLabelText("Mark Renew car insurance done"));
    expect(mockApi.completeDeadline).toHaveBeenCalledWith(1);
    // Still an open card while the write is out.
    expect(screen.getByTestId("deadline-1-complete")).toBeTruthy();
    expect(screen.getByTestId("deadline-1-delete").props.accessibilityState).toEqual({ disabled: true });

    mockApi.listDeadlines.mockResolvedValue(page([deadline({ completed_at: "2026-09-27T02:00:00Z" })]));
    await act(async () => finish(deadline({ completed_at: "2026-09-27T02:00:00Z" })));

    expect(screen.queryByTestId("deadline-1-complete")).toBeNull();
    expect(screen.getByTestId("deadlines-completed")).toBeTruthy();
  });

  it("says why Done was refused, on its card", async () => {
    mockApi.completeDeadline.mockRejectedValue(apiError(404, "No query results."));
    render(<DeadlinesView active />);

    const done = await screen.findByLabelText("Mark Renew car insurance done");
    await act(async () => fireEvent.press(done));
    expect(within(screen.getByTestId("deadline-1")).getByText("No query results.")).toBeTruthy();
  });

  it("commits a title on blur and re-reads", async () => {
    render(<DeadlinesView active />);
    const title = await screen.findByTestId("deadline-1-title");

    fireEvent.changeText(title, "Renew the car insurance");
    expect(mockApi.updateDeadline).not.toHaveBeenCalled();

    await act(async () => fireEvent(title, "blur"));
    expect(mockApi.updateDeadline).toHaveBeenCalledWith(1, { title: "Renew the car insurance" });
    expect(mockApi.listDeadlines).toHaveBeenCalledTimes(2);
  });

  it("puts the stored due date back when the field is emptied — a deadline needs a day", async () => {
    render(<DeadlinesView active />);
    const due = await screen.findByTestId("deadline-1-due-on");

    fireEvent.changeText(due, "");
    await act(async () => fireEvent(due, "blur"));

    expect(mockApi.updateDeadline).not.toHaveBeenCalled();
    expect(screen.getByTestId("deadline-1-due-on").props.value).toBe(shift(10));
  });

  it("moves the due date", async () => {
    render(<DeadlinesView active />);
    const due = await screen.findByTestId("deadline-1-due-on");

    fireEvent.changeText(due, "2027-01-31");
    await act(async () => fireEvent(due, "blur"));

    expect(mockApi.updateDeadline).toHaveBeenCalledWith(1, { due_on: "2027-01-31" });
  });

  it("links a document, and clears the link as null", async () => {
    render(<DeadlinesView active />);
    fireEvent.press(await screen.findByTestId("deadline-1-document-picker"));

    // The re-read after the write finds the link.
    mockApi.listDeadlines.mockResolvedValue(page([deadline({ document_id: 7, document: policy() })]));
    await act(async () => fireEvent.press(screen.getByText("Car policy")));
    expect(mockApi.updateDeadline).toHaveBeenCalledWith(1, { document_id: 7 });
    expect(within(screen.getByTestId("deadline-1-document")).getByText("Car policy")).toBeTruthy();

    mockApi.updateDeadline.mockClear();
    fireEvent.press(screen.getByTestId("deadline-1-document-picker"));
    await act(async () => fireEvent.press(screen.getByText("No document")));
    expect(mockApi.updateDeadline).toHaveBeenCalledWith(1, { document_id: null });
  });

  it("asks before deleting, and says the linked document stays", async () => {
    mockApi.listDeadlines.mockResolvedValue(page([deadline({ document_id: 7, document: policy() })]));
    render(<DeadlinesView active />);

    fireEvent.press(await screen.findByLabelText("Delete Renew car insurance"));
    expect(mockApi.deleteDeadline).not.toHaveBeenCalled();
    expect(screen.getByText("The deadline goes; Car policy stays filed.")).toBeTruthy();

    await act(async () => fireEvent.press(screen.getAllByText("Delete").at(-1)!));
    expect(mockApi.deleteDeadline).toHaveBeenCalledWith(1);
  });
});

describe("completed deadlines", () => {
  const done = deadline({ id: 3, title: "File the return", completed_at: "2026-04-10T03:00:00Z" });

  it("sit collapsed behind a toggle, with a count", async () => {
    mockApi.listDeadlines.mockResolvedValue(page([deadline(), done]));
    render(<DeadlinesView active />);

    const card = within(await screen.findByTestId("deadlines-completed"));
    expect(card.getByText("1")).toBeTruthy();
    expect(screen.queryByText("File the return")).toBeNull();

    fireEvent.press(screen.getByLabelText("Show completed deadlines"));
    expect(screen.getByText("File the return")).toBeTruthy();
    expect(screen.getByText(`done ${localToday(new Date(done.completed_at!))}`)).toBeTruthy();
  });

  it("are reopened by a write", async () => {
    mockApi.listDeadlines.mockResolvedValue(page([done]));
    render(<DeadlinesView active />);

    fireEvent.press(await screen.findByLabelText("Show completed deadlines"));
    await act(async () => fireEvent.press(screen.getByLabelText("Reopen File the return")));

    expect(mockApi.reopenDeadline).toHaveBeenCalledWith(3);
    expect(mockApi.listDeadlines).toHaveBeenCalledTimes(2);
  });

  it("make the empty card say everything is done, not that nothing is tracked", async () => {
    mockApi.listDeadlines.mockResolvedValue(page([done]));
    render(<DeadlinesView active />);

    expect(await screen.findByText("Everything tracked is done.")).toBeTruthy();
  });

  it("draw no toggle when there are none", async () => {
    render(<DeadlinesView active />);
    await screen.findByTestId("deadline-1");

    expect(screen.queryByTestId("deadlines-completed")).toBeNull();
  });
});

describe("tracking a new one", () => {
  const fill = async () => {
    fireEvent.changeText(await screen.findByTestId("deadline-new-title"), " Pay the premium ");
    fireEvent.press(screen.getByTestId("deadline-new-kind"));
    fireEvent.press(screen.getByText("Payment"));
    fireEvent.changeText(screen.getByTestId("deadline-new-due"), "2026-10-15");
  };

  it("needs a title, a kind and a due date", async () => {
    render(<DeadlinesView active />);
    expect((await screen.findByTestId("deadline-new-submit")).props.accessibilityState).toEqual({ disabled: true });

    await fill();
    expect(screen.getByTestId("deadline-new-submit").props.accessibilityState).toEqual({ disabled: false });
  });

  it("creates it with its blanks as null, and clears the form", async () => {
    render(<DeadlinesView active />);
    await fill();

    await act(async () => fireEvent.press(screen.getByTestId("deadline-new-submit")));

    expect(mockApi.createDeadline).toHaveBeenCalledWith({
      title: "Pay the premium",
      kind: "payment",
      due_on: "2026-10-15",
      document_id: null,
      notes: null,
    });
    expect(screen.getByTestId("deadline-new-title").props.value).toBe("");
  });

  it("can point at a filed document", async () => {
    render(<DeadlinesView active />);
    await fill();
    fireEvent.press(screen.getByTestId("deadline-new-document"));
    fireEvent.press(screen.getByText("Car policy"));

    await act(async () => fireEvent.press(screen.getByTestId("deadline-new-submit")));
    expect(mockApi.createDeadline).toHaveBeenCalledWith(expect.objectContaining({ document_id: 7 }));
  });

  it("keeps the form when it was refused, and says why", async () => {
    mockApi.createDeadline.mockRejectedValue(apiError(422, "The selected document id is invalid."));
    render(<DeadlinesView active />);
    await fill();

    await act(async () => fireEvent.press(screen.getByTestId("deadline-new-submit")));

    expect(within(screen.getByTestId("deadline-new")).getByText("The selected document id is invalid.")).toBeTruthy();
    expect(screen.getByTestId("deadline-new-title").props.value).toBe(" Pay the premium ");
  });
});

describe("the labels", () => {
  it("counts whole days on the wall calendar", () => {
    expect(daysBetween("2026-09-27", "2026-09-27")).toBe(0);
    expect(daysBetween("2026-09-27", "2026-10-01")).toBe(4);
    expect(daysBetween("2026-09-27", "2026-09-20")).toBe(-7);
    // Across a month and a year.
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("says when it is due, and how late it is", () => {
    expect(dueLabel("2026-09-27", "2026-09-27")).toBe("due today");
    expect(dueLabel("2026-09-28", "2026-09-27")).toBe("due tomorrow");
    expect(dueLabel("2026-10-07", "2026-09-27")).toBe("in 10 days");
    expect(dueLabel("2026-09-26", "2026-09-27")).toBe("overdue 1 day");
    expect(dueLabel("2026-09-20", "2026-09-27")).toBe("overdue 7 days");
  });

  it("uses today's date by default", () => {
    expect(dueLabel(TODAY)).toBe("due today");
  });
});
