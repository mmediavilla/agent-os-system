import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import InstructionsView from "../InstructionsView";
import { ApiError, AssistantInstruction, api } from "../../api";

/**
 * Assistant → Instructions: the words Claude is given that the owner may change.
 *
 * What matters is that the list is the server's, that blank is the default and
 * never "no instructions", that nothing is drawn as saved before the server
 * says so, and that a paste over the limit is refused without being thrown
 * away.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    getAssistantInstructions: jest.fn(),
    patchAssistantInstructions: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const PERSONA = "You are a highly capable personal AI butler.";

const row = (extra: Partial<AssistantInstruction> = {}): AssistantInstruction => ({
  key: "persona",
  label: "Persona",
  used_by: "Leads every typed and spoken turn.",
  text: PERSONA,
  default: PERSONA,
  reworded: false,
  ...extra,
});

const nudge = (extra: Partial<AssistantInstruction> = {}): AssistantInstruction =>
  row({ key: "nudge", label: "Morning nudge", used_by: "The whole brief for the nudge.", text: "Under 70 words.", default: "Under 70 words.", ...extra });

const state = (data: AssistantInstruction[], max_chars = 4000) => ({ data, max_chars });

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status }) as ApiError;

beforeEach(() => {
  jest.resetAllMocks();
  mockApi.getAssistantInstructions.mockResolvedValue(state([row(), nudge()]));
  mockApi.patchAssistantInstructions.mockResolvedValue(state([row(), nudge()]));
});

it("reads on arrival and not before, and draws the server's list", async () => {
  const view = render(<InstructionsView active={false} />);
  expect(mockApi.getAssistantInstructions).not.toHaveBeenCalled();

  view.rerender(<InstructionsView active />);
  await screen.findByTestId("instruction-persona");

  expect(screen.getByTestId("instruction-nudge")).toBeTruthy();
  expect(screen.getByTestId("instruction-persona-input").props.value).toBe(PERSONA);
  expect(screen.getByTestId("instruction-persona-used-by")).toHaveTextContent("Leads every typed and spoken turn.");
  expect(screen.getByTestId("instruction-persona-note")).toHaveTextContent(/The default/);
  expect(screen.queryByTestId("instruction-persona-reset")).toBeNull();
});

it("says so when the list cannot be read", async () => {
  mockApi.getAssistantInstructions.mockRejectedValue(apiError(500, "Server error."));
  render(<InstructionsView active />);

  expect(await screen.findByTestId("instructions-error")).toHaveTextContent(/Server error\./);
});

it("rewords on blur, and draws the answer rather than the draft", async () => {
  mockApi.patchAssistantInstructions.mockResolvedValue(state([row({ text: "Call me Boss.", reworded: true }), nudge()]));
  render(<InstructionsView active />);
  const field = await screen.findByTestId("instruction-persona-input");

  fireEvent.changeText(field, "  Call me Boss.  ");
  await act(async () => fireEvent(field, "blur"));

  expect(mockApi.patchAssistantInstructions).toHaveBeenCalledWith({ persona: "Call me Boss." });
  await waitFor(() => expect(screen.getByTestId("instruction-persona-note")).toHaveTextContent(/Reworded by you/));
  expect(screen.getByTestId("instruction-persona-input").props.value).toBe("Call me Boss.");
});

it("sends nothing for an unchanged field or an emptied default, and puts the default back", async () => {
  render(<InstructionsView active />);
  const field = await screen.findByTestId("instruction-persona-input");

  await act(async () => fireEvent(field, "blur"));
  fireEvent.changeText(field, "   ");
  await act(async () => fireEvent(field, "blur"));

  expect(mockApi.patchAssistantInstructions).not.toHaveBeenCalled();
  expect(screen.getByTestId("instruction-persona-input").props.value).toBe(PERSONA);
});

it("clearing a rewording sends the blank, and Reset sends null", async () => {
  mockApi.getAssistantInstructions.mockResolvedValue(state([row({ text: "Mine.", reworded: true }), nudge()]));
  render(<InstructionsView active />);
  const field = await screen.findByTestId("instruction-persona-input");

  fireEvent.changeText(field, "");
  await act(async () => fireEvent(field, "blur"));
  expect(mockApi.patchAssistantInstructions).toHaveBeenLastCalledWith({ persona: "" });

  // The first answer put the default back; read a rewording again for Reset.
  mockApi.patchAssistantInstructions.mockResolvedValue(state([row({ text: "Mine.", reworded: true }), nudge()]));
  fireEvent.changeText(screen.getByTestId("instruction-persona-input"), "Mine, again.");
  await act(async () => fireEvent(screen.getByTestId("instruction-persona-input"), "blur"));

  await act(async () => fireEvent.press(await screen.findByTestId("instruction-persona-reset")));
  expect(mockApi.patchAssistantInstructions).toHaveBeenLastCalledWith({ persona: null });
});

it("refuses a paste over the limit without sending it or throwing it away", async () => {
  mockApi.getAssistantInstructions.mockResolvedValue(state([row(), nudge()], 10));
  render(<InstructionsView active />);
  const field = await screen.findByTestId("instruction-persona-input");

  fireEvent.changeText(field, "Far too long for ten.");
  await act(async () => fireEvent(field, "blur"));

  expect(mockApi.patchAssistantInstructions).not.toHaveBeenCalled();
  expect(screen.getByTestId("instruction-persona")).toHaveTextContent(/At most 10 characters — this is 21\./);
  expect(screen.getByTestId("instruction-persona-input").props.value).toBe("Far too long for ten.");
});

it("keeps a refused write's sentence on its own card, and redraws the stored text", async () => {
  mockApi.patchAssistantInstructions.mockRejectedValue(apiError(422, "An instruction is at most 4000 characters."));
  render(<InstructionsView active />);
  const field = await screen.findByTestId("instruction-nudge-input");

  fireEvent.changeText(field, "Something new.");
  await act(async () => fireEvent(field, "blur"));

  await waitFor(() =>
    expect(screen.getByTestId("instruction-nudge")).toHaveTextContent(/An instruction is at most 4000 characters\./),
  );
  expect(screen.getByTestId("instruction-persona")).not.toHaveTextContent(/at most 4000/);
  expect(screen.getByTestId("instruction-nudge-input").props.value).toBe("Under 70 words.");
});
