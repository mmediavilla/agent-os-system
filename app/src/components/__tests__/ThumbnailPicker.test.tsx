import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { Image } from "react-native";
import ThumbnailPicker from "../ThumbnailPicker";
import { EQUIPMENT_ARTS, EQUIPMENT_ART_LABELS, defaultEquipmentImage, equipmentArtImage } from "../../equipmentArt";

const uriOf = (q: ReturnType<typeof render>, testID: string) =>
  (q.UNSAFE_getAllByType(Image).find((n) => n.props.testID === testID)?.props.source as { uri: string })?.uri;

function renderPicker(props: Partial<React.ComponentProps<typeof ThumbnailPicker>> = {}) {
  const onChange = jest.fn();
  const q = render(
    <ThumbnailPicker
      value={null}
      onChange={onChange}
      name="Olympic Barbell"
      equipmentType="Free Weight"
      {...props}
    />,
  );
  return { q, onChange };
}

it("offers every drawing, plus letting the name choose", () => {
  const { q } = renderPicker();

  expect(q.getByText("Automatic")).toBeTruthy();
  for (const art of EQUIPMENT_ARTS) {
    expect(q.getByText(EQUIPMENT_ART_LABELS[art])).toBeTruthy();
    expect(uriOf(q, `thumbnail-option-${art}`)).toBe(equipmentArtImage(art));
  }
});

it("previews what Automatic would draw for the item being edited", () => {
  // Not a generic placeholder: choosing it should not be a leap of faith.
  const { q } = renderPicker({ name: "Concept2 Rower", equipmentType: "Cardio" });

  expect(uriOf(q, "thumbnail-option-auto")).toBe(defaultEquipmentImage("Concept2 Rower", "Cardio"));
});

it("marks the pinned drawing as the selected one", () => {
  const { q } = renderPicker({ value: "kettlebell" });

  expect(q.getByRole("button", { name: "Kettlebell thumbnail", selected: true })).toBeTruthy();
  expect(q.getByRole("button", { name: "Automatic thumbnail", selected: false })).toBeTruthy();
});

it("falls back to Automatic when nothing is pinned", () => {
  // "" is what a cleared value looks like coming back from a form; a key this
  // build cannot draw is what an older row looks like.
  for (const empty of [null, "", "hovercraft"]) {
    const { q } = renderPicker({ value: empty });
    expect(q.getByRole("button", { name: "Automatic thumbnail", selected: true })).toBeTruthy();
  }
});


it("reports a pick as the art key, and Automatic as no key at all", () => {
  const { q, onChange } = renderPicker();

  fireEvent.press(q.getByText("Treadmill"));
  expect(onChange).toHaveBeenCalledWith("treadmill");

  fireEvent.press(q.getByText("Automatic"));
  // Null, not "auto": the screen stores this, and the column is nullable so a
  // cleared pick keeps following the name.
  expect(onChange).toHaveBeenLastCalledWith(null);
});

it("takes no picks while the sheet is busy", () => {
  const { q, onChange } = renderPicker({ disabled: true });

  fireEvent.press(q.getByText("Treadmill"));

  expect(onChange).not.toHaveBeenCalled();
});
