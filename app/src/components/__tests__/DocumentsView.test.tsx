import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import DocumentsView, { expiryLabel, fileLabel } from "../DocumentsView";
import { localToday } from "../RecordsParts";
import { ApiError, FiledDocument, api } from "../../api";
import { captureFilePicker } from "../../testing/filePicker";

/**
 * Records → Documents: the filing cabinet.
 *
 * What matters is that nothing is drawn as saved before the server says so,
 * that filing with a file is two requests and a failed upload leaves the
 * record saved (and says so on its card, not on a form that would file it
 * twice), that a cleared date is sent as null, and that the two things that
 * delete bytes — Delete and Remove file — both ask first.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listDocuments: jest.fn(),
    createDocument: jest.fn(),
    updateDocument: jest.fn(),
    deleteDocument: jest.fn(),
    uploadDocumentFile: jest.fn(),
    deleteDocumentFile: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const doc = (extra: Partial<FiledDocument> = {}): FiledDocument => ({
  id: 1,
  title: "Passport",
  kind: "passport",
  issued_on: "2020-01-15",
  expires_on: "2030-01-14",
  notes: null,
  mime: null,
  size_bytes: null,
  file_url: null,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  ...extra,
});

const page = (data: FiledDocument[]) => ({
  data,
  meta: { page: 1, per_page: null, total: data.length, last_page: 1 } as never,
});

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status }) as ApiError;

const pdf = () => new File(["%PDF-1.4"], "policy.pdf", { type: "application/pdf" });

beforeEach(() => {
  jest.resetAllMocks();
  mockApi.listDocuments.mockResolvedValue(page([doc()]));
  mockApi.updateDocument.mockResolvedValue(doc());
  mockApi.createDocument.mockResolvedValue(doc({ id: 2, title: "Car policy", kind: "policy" }));
  mockApi.deleteDocument.mockResolvedValue(undefined);
  mockApi.uploadDocumentFile.mockResolvedValue(doc());
  mockApi.deleteDocumentFile.mockResolvedValue(doc());
});

it("reads on arrival and not before", async () => {
  const view = render(<DocumentsView active={false} />);
  expect(mockApi.listDocuments).not.toHaveBeenCalled();

  view.rerender(<DocumentsView active />);
  expect(await screen.findByTestId("document-1")).toBeTruthy();
  expect(mockApi.listDocuments).toHaveBeenCalledTimes(1);
});

it("says so when nothing is filed, and still offers the add card", async () => {
  mockApi.listDocuments.mockResolvedValue(page([]));
  render(<DocumentsView active />);

  expect(await screen.findByTestId("documents-empty")).toBeTruthy();
  expect(screen.getByTestId("document-new")).toBeTruthy();
});

it("says why when the cabinet cannot be read", async () => {
  mockApi.listDocuments.mockRejectedValue(apiError(500, "The database is locked."));
  render(<DocumentsView active />);

  expect(await screen.findByText("The database is locked.")).toBeTruthy();
  expect(screen.queryByTestId("document-new")).toBeNull();
});

describe("a filed document", () => {
  it("names its file and opens it in a tab through the signed URL", async () => {
    mockApi.listDocuments.mockResolvedValue(
      page([doc({ file_url: "https://projectmc.test/api/documents/1/file?signature=x", mime: "application/pdf", size_bytes: 2048 })]),
    );
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    render(<DocumentsView active />);

    const card = within(await screen.findByTestId("document-1"));
    expect(card.getByText("PDF · 2 KB")).toBeTruthy();
    expect(card.getByText("PDF")).toBeTruthy();

    fireEvent.press(card.getByLabelText("Open Passport"));
    expect(open).toHaveBeenCalledWith("https://projectmc.test/api/documents/1/file?signature=x", "_blank", "noopener");
    open.mockRestore();
  });

  it("draws a filed picture on its card", async () => {
    mockApi.listDocuments.mockResolvedValue(page([doc({ file_url: "https://x/pic", mime: "image/jpeg", size_bytes: 10 })]));
    render(<DocumentsView active />);

    const preview = await screen.findByTestId("document-1-preview");
    expect(preview.props.source).toEqual({ uri: "https://x/pic" });
  });

  it("offers Upload with no file, and no Open or Remove", async () => {
    render(<DocumentsView active />);
    const card = within(await screen.findByTestId("document-1"));

    expect(card.getByText("Upload")).toBeTruthy();
    expect(card.queryByText("Open")).toBeNull();
    expect(card.queryByText("Remove file")).toBeNull();
    expect(card.getByText("No file")).toBeTruthy();
  });

  it("commits a title on blur, not per keystroke, and re-reads the list", async () => {
    render(<DocumentsView active />);
    const title = await screen.findByTestId("document-1-title");

    fireEvent.changeText(title, "Passport (PH)");
    expect(mockApi.updateDocument).not.toHaveBeenCalled();

    await act(async () => fireEvent(title, "blur"));
    expect(mockApi.updateDocument).toHaveBeenCalledWith(1, { title: "Passport (PH)" });
    expect(mockApi.listDocuments).toHaveBeenCalledTimes(2);
  });

  it("pulls a refused title back to what is stored, and says why", async () => {
    mockApi.updateDocument.mockRejectedValue(apiError(422, "The title field must not be greater than 160 characters."));
    render(<DocumentsView active />);
    const title = await screen.findByTestId("document-1-title");

    fireEvent.changeText(title, "x".repeat(200));
    await act(async () => fireEvent(title, "blur"));

    expect(screen.getByText("The title field must not be greater than 160 characters.")).toBeTruthy();
    expect(screen.getByTestId("document-1-title").props.value).toBe("Passport");
  });

  it("sends a cleared date as null — a receipt has no expiry", async () => {
    render(<DocumentsView active />);
    const expires = await screen.findByTestId("document-1-expires");

    fireEvent.changeText(expires, "");
    await act(async () => fireEvent(expires, "blur"));

    expect(mockApi.updateDocument).toHaveBeenCalledWith(1, { expires_on: null });
  });

  it("refuses a malformed date without writing", async () => {
    render(<DocumentsView active />);
    const issued = await screen.findByTestId("document-1-issued");

    fireEvent.changeText(issued, "15/01/2020");
    await act(async () => fireEvent(issued, "blur"));

    expect(mockApi.updateDocument).not.toHaveBeenCalled();
    expect(screen.getByText("Use a date like 2027-03-14.")).toBeTruthy();
  });

  it("clears notes to null rather than an empty string", async () => {
    mockApi.listDocuments.mockResolvedValue(page([doc({ notes: "In the blue folder." })]));
    render(<DocumentsView active />);
    const notes = await screen.findByTestId("document-1-notes");

    fireEvent.changeText(notes, "  ");
    await act(async () => fireEvent(notes, "blur"));

    expect(mockApi.updateDocument).toHaveBeenCalledWith(1, { notes: null });
  });

  it("uploads a chosen file straight away, and redraws from the answer", async () => {
    const picker = captureFilePicker();
    render(<DocumentsView active />);
    fireEvent.press(await screen.findByLabelText("Upload a file for Passport"));

    expect(picker.input.accept).toBe("application/pdf,image/jpeg,image/png,image/webp");
    const file = pdf();
    await picker.choose(file);

    await waitFor(() => expect(mockApi.uploadDocumentFile).toHaveBeenCalledWith(1, file));
    await waitFor(() => expect(mockApi.listDocuments).toHaveBeenCalledTimes(2));
    jest.restoreAllMocks();
  });

  it("says why an upload was refused, on the card", async () => {
    const picker = captureFilePicker();
    mockApi.uploadDocumentFile.mockRejectedValue(apiError(413, "That file is over the 20 MB limit."));
    render(<DocumentsView active />);
    fireEvent.press(await screen.findByLabelText("Upload a file for Passport"));
    await picker.choose(pdf());

    const card = within(await screen.findByTestId("document-1"));
    expect(await card.findByText("That file is over the 20 MB limit.")).toBeTruthy();
    jest.restoreAllMocks();
  });

  it("asks before removing a file, and keeps the record", async () => {
    mockApi.listDocuments.mockResolvedValue(page([doc({ file_url: "https://x/f", mime: "application/pdf", size_bytes: 1 })]));
    render(<DocumentsView active />);

    fireEvent.press(await screen.findByLabelText("Remove the file from Passport"));
    expect(mockApi.deleteDocumentFile).not.toHaveBeenCalled();
    expect(screen.getByText("Remove the file from Passport?")).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByText("Remove")));
    expect(mockApi.deleteDocumentFile).toHaveBeenCalledWith(1);
    expect(mockApi.deleteDocument).not.toHaveBeenCalled();
  });

  it("asks before deleting, and a cancel deletes nothing", async () => {
    render(<DocumentsView active />);

    fireEvent.press(await screen.findByLabelText("Delete Passport"));
    expect(screen.getByText("Delete Passport?")).toBeTruthy();
    fireEvent.press(screen.getByText("Cancel"));
    expect(mockApi.deleteDocument).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Delete Passport"));
    await act(async () => fireEvent.press(screen.getAllByText("Delete").at(-1)!));
    expect(mockApi.deleteDocument).toHaveBeenCalledWith(1);
  });
});

describe("filing a new one", () => {
  const fill = async () => {
    fireEvent.changeText(await screen.findByTestId("document-new-title"), "  Car policy ");
    fireEvent.press(screen.getByTestId("document-new-kind"));
    fireEvent.press(screen.getByText("Policy"));
  };

  it("needs a title and a kind before it can be filed", async () => {
    render(<DocumentsView active />);
    const submit = await screen.findByTestId("document-new-submit");
    expect(submit.props.accessibilityState).toEqual({ disabled: true });

    await fill();
    expect(screen.getByTestId("document-new-submit").props.accessibilityState).toEqual({ disabled: false });
  });

  it("creates the record with its blanks as null, and no upload without a file", async () => {
    render(<DocumentsView active />);
    await fill();

    await act(async () => fireEvent.press(screen.getByTestId("document-new-submit")));

    expect(mockApi.createDocument).toHaveBeenCalledWith({
      title: "Car policy",
      kind: "policy",
      issued_on: null,
      expires_on: null,
      notes: null,
    });
    expect(mockApi.uploadDocumentFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("document-new-title").props.value).toBe("");
  });

  it("files with a file in two requests: create, then upload against the new id", async () => {
    const picker = captureFilePicker();
    render(<DocumentsView active />);
    await fill();

    fireEvent.press(screen.getByTestId("document-new-choose"));
    const file = pdf();
    await picker.choose(file);
    expect(screen.getByText("policy.pdf")).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByTestId("document-new-submit")));

    expect(mockApi.createDocument).toHaveBeenCalled();
    expect(mockApi.uploadDocumentFile).toHaveBeenCalledWith(2, file);
    jest.restoreAllMocks();
  });

  it("clears the form when the record was saved but its file was not, and says so on the new card", async () => {
    const picker = captureFilePicker();
    mockApi.uploadDocumentFile.mockRejectedValue(apiError(422, "Only a PDF or a JPEG, PNG or WebP picture can be filed."));
    // The re-read after the write finds the new record.
    mockApi.listDocuments
      .mockResolvedValueOnce(page([doc()]))
      .mockResolvedValue(page([doc(), doc({ id: 2, title: "Car policy", kind: "policy" })]));
    render(<DocumentsView active />);
    await fill();
    fireEvent.press(screen.getByTestId("document-new-choose"));
    await picker.choose(pdf());

    await act(async () => fireEvent.press(screen.getByTestId("document-new-submit")));

    const card = within(await screen.findByTestId("document-2"));
    expect(
      card.getByText("Filed without its file — Only a PDF or a JPEG, PNG or WebP picture can be filed."),
    ).toBeTruthy();
    expect(screen.getByTestId("document-new-title").props.value).toBe("");
    jest.restoreAllMocks();
  });

  it("keeps the form when the record itself was refused", async () => {
    mockApi.createDocument.mockRejectedValue(apiError(422, "The kind field is required."));
    render(<DocumentsView active />);
    await fill();

    await act(async () => fireEvent.press(screen.getByTestId("document-new-submit")));

    expect(within(screen.getByTestId("document-new")).getByText("The kind field is required.")).toBeTruthy();
    expect(screen.getByTestId("document-new-title").props.value).toBe("  Car policy ");
  });
});

describe("the labels", () => {
  it("says when a document expires, and that it has", () => {
    expect(expiryLabel(null, "2026-09-26")).toBeUndefined();
    expect(expiryLabel("2030-01-14", "2026-09-26")).toBe("expires 2030-01-14");
    expect(expiryLabel("2026-09-26", "2026-09-26")).toBe("expires 2026-09-26");
    expect(expiryLabel("2026-09-25", "2026-09-26")).toBe("expired 2026-09-25");
  });

  it("reads today off the local clock, not UTC", () => {
    // 23:30 local on the 26th is the 26th, whatever the zone.
    expect(localToday(new Date(2026, 8, 26, 23, 30))).toBe("2026-09-26");
  });

  it("names a file by what it is and how big", () => {
    expect(fileLabel({ file_url: null, mime: null, size_bytes: null })).toBe("none");
    expect(fileLabel({ file_url: "u", mime: "image/webp", size_bytes: null })).toBe("WEBP");
  });

  it("keeps a kind outside the vocabulary rather than losing it", async () => {
    mockApi.listDocuments.mockResolvedValue(page([doc({ kind: "tax return" })]));
    render(<DocumentsView active />);

    expect(within(await screen.findByTestId("document-1-kind")).getByText("Tax return")).toBeTruthy();
  });
});
