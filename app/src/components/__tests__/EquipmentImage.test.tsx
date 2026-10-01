import React from "react";
import { render } from "@testing-library/react-native";
import { Image } from "react-native";
import EquipmentImage from "../EquipmentImage";
import { defaultEquipmentImage } from "../../equipmentArt";

const uriOf = (q: ReturnType<typeof render>, testID: string) =>
  (q.UNSAFE_getAllByType(Image).find((n) => n.props.testID === testID)?.props.source as { uri: string })?.uri;

function renderImage(props: Partial<React.ComponentProps<typeof EquipmentImage>> = {}) {
  return render(
    <EquipmentImage
      uri={null}
      name="Olympic Barbell"
      equipmentType="Free Weight"
      testID="pic"
      {...props}
    />,
  );
}

it("draws the default illustration when there is no photo", () => {
  const q = renderImage();

  expect(uriOf(q, "pic-default")).toBe(defaultEquipmentImage("Olympic Barbell", "Free Weight"));
});

it("shows the uploaded photo instead once there is one", () => {
  const q = renderImage({ uri: "http://api.test/api/equipment/1/image?v=1" });

  expect(uriOf(q, "pic-photo")).toBe("http://api.test/api/equipment/1/image?v=1");
  // No drawing underneath it — a photo is the whole picture, not a backdrop.
  expect(uriOf(q, "pic-default")).toBeUndefined();
});

it("draws the illustration the item is pinned to, over the one its name implies", () => {
  const q = renderImage({ thumbnail: "kettlebell" });

  expect(uriOf(q, "pic-default")).toBe(
    defaultEquipmentImage("Olympic Barbell", "Free Weight", "kettlebell"),
  );
  expect(uriOf(q, "pic-default")).not.toBe(defaultEquipmentImage("Olympic Barbell", "Free Weight"));
});

it("ignores the pinned illustration once there is a photo", () => {
  const q = renderImage({ thumbnail: "kettlebell", uri: "http://api.test/api/equipment/1/image?v=1" });

  expect(uriOf(q, "pic-photo")).toBe("http://api.test/api/equipment/1/image?v=1");
  expect(uriOf(q, "pic-default")).toBeUndefined();
});

it("picks the drawing from the name over the category", () => {
  const q = renderImage({ name: "Concept2 Rower", equipmentType: "Cardio" });

  expect(uriOf(q, "pic-default")).toBe(defaultEquipmentImage("Concept2 Rower", "Cardio"));
  expect(uriOf(q, "pic-default")).not.toBe(defaultEquipmentImage("Unnamed", "Cardio"));
});

it("still draws something for an item with no name yet", () => {
  // The create sheet renders this on every keystroke, starting from "".
  const q = renderImage({ name: "" });

  expect(uriOf(q, "pic-default")).toBe(defaultEquipmentImage("", "Free Weight"));
});

it("lets a photo fill the frame and a drawing sit inside it", () => {
  const drawn = renderImage();
  const photo = renderImage({ uri: "http://api.test/api/equipment/1/image?v=1" });

  // A photo is cropped to the box; a drawing must not be, or it loses its edges.
  expect(photo.UNSAFE_getAllByType(Image)[0].props.resizeMode).toBe("cover");
  expect(drawn.UNSAFE_getAllByType(Image)[0].props.resizeMode).toBe("contain");
});
