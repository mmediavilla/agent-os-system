import { EQUIPMENT_TYPES } from "../equipmentConstants";
import {
  EQUIPMENT_ARTS,
  EQUIPMENT_ART_LABELS,
  EquipmentArt,
  defaultEquipmentImage,
  equipmentArtFor,
  equipmentArtImage,
  equipmentArtSvg,
  isEquipmentArt,
} from "../equipmentArt";

/** The catalog seeds a name and a type; the art has to come from one or the other. */
const art = (name: string, type = "Other") => equipmentArtFor(name, type);

describe("equipmentArtFor — by name", () => {
  it.each<[string, EquipmentArt]>([
    ["Olympic Barbell", "barbell"],
    ["EZ Curl Bar", "barbell"],
    ["Adjustable Dumbbells", "dumbbell"],
    ["24kg Kettlebell", "kettlebell"],
    ["Bumper Plates", "plate"],
    ["Flat Bench", "bench"],
    ["Power Rack", "rack"],
    ["Pull-up Bar", "pullup"],
    ["Gymnastic Rings", "pullup"],
    ["Treadmill", "treadmill"],
    ["Assault Bike", "bike"],
    ["Concept2 Rower", "rower"],
    ["Cable Crossover", "cable"],
    ["Resistance Bands", "band"],
    ["Battle Rope", "rope"],
    ["Yoga Mat", "mat"],
    ["Leg Press", "machine"],
  ])("draws %s as a %s", (name, expected) => {
    expect(art(name)).toBe(expected);
  });

  it("reads a name however it is punctuated or capitalised", () => {
    for (const spelling of ["Pull-up bar", "PULL UP BAR", "pull_up  bar"]) {
      expect(art(spelling)).toBe("pullup");
    }
  });

  it("matches whole words, so a name that merely contains a keyword is not caught", () => {
    // " mat " must not fire inside "Matrix" — these fall through to the type.
    expect(art("Matrix Leg Extension", "Machine")).toBe("machine");
    expect(art("Bar Stool", "Accessory")).toBe("duffel");
  });

  it("keeps the more specific reading when two keywords are present", () => {
    // Both hit "machine" too; the first match is the one that says more.
    expect(art("Smith Machine")).toBe("rack");
    expect(art("Bench Press Machine")).toBe("bench");
    expect(art("Cable Machine")).toBe("cable");
  });

  it("does not let the plural rule eat a double s", () => {
    // "press" → "pres" would drop Leg Press onto the type default.
    expect(art("Leg Press")).toBe("machine");
    expect(art("Weight Plates")).toBe("plate");
  });
});

describe("equipmentArtFor — pinned", () => {
  it("shows the drawing the item was pinned to, whatever its name says", () => {
    // The picker exists for exactly this: a name the keywords read wrongly.
    expect(art("Olympic Barbell")).toBe("barbell");
    expect(equipmentArtFor("Olympic Barbell", "Free Weight", "duffel")).toBe("duffel");
  });

  it("keeps the pinned drawing when the name changes under it", () => {
    // A rename is the reason the pick is stored rather than recomputed.
    expect(equipmentArtFor("Treadmill", "Cardio", "rower")).toBe("rower");
  });

  it("derives one again once the pin is cleared", () => {
    for (const cleared of [null, undefined, ""]) {
      expect(equipmentArtFor("Treadmill", "Cardio", cleared)).toBe("treadmill");
    }
  });

  it("falls back to the derived drawing for a key it cannot draw", () => {
    // Reachable from an older row if a key is ever retired: better the name's
    // drawing than an empty box.
    expect(equipmentArtFor("Treadmill", "Cardio", "hovercraft")).toBe("treadmill");
  });
});

describe("isEquipmentArt", () => {
  it("accepts every drawing and nothing else", () => {
    for (const one of EQUIPMENT_ARTS) expect(isEquipmentArt(one)).toBe(true);

    for (const other of [null, undefined, "", "Barbell", "hovercraft", 3, {}]) {
      expect(isEquipmentArt(other)).toBe(false);
    }
  });

  it("does not mistake an inherited property for a drawing", () => {
    // ART is an object literal, so "toString" and friends are `in` it.
    expect(isEquipmentArt("toString")).toBe(false);
    expect(isEquipmentArt("constructor")).toBe(false);
  });
});

describe("EQUIPMENT_ART_LABELS", () => {
  it("names every drawing the picker offers", () => {
    for (const one of EQUIPMENT_ARTS) {
      expect(EQUIPMENT_ART_LABELS[one]).toBeTruthy();
    }
    expect(Object.keys(EQUIPMENT_ART_LABELS).sort()).toEqual([...EQUIPMENT_ARTS].sort());
  });
});

describe("equipmentArtFor — by type", () => {
  it("falls back to the category when the name says nothing specific", () => {
    expect(art("Rogue RML-3", "Machine")).toBe("machine");
    expect(art("Rogue RML-3", "Cardio")).toBe("treadmill");
    expect(art("Rogue RML-3", "Free Weight")).toBe("dumbbell");
  });

  it("gives every offered category a drawing", () => {
    for (const type of EQUIPMENT_TYPES) {
      expect(equipmentArtSvg(art("Unnamed", type)).length).toBeGreaterThan(0);
    }
  });

  it("falls through to the duffel for a category nothing maps", () => {
    // equipment_type is free text on the API, so this is reachable.
    expect(art("", "Recovery")).toBe("duffel");
    expect(art("", "")).toBe("duffel");
  });

  it("ignores the case and padding of a stored type", () => {
    expect(art("Unnamed", "  cardio ")).toBe("treadmill");
  });
});

describe("equipmentArtSvg", () => {
  it("produces a square, self-describing SVG", () => {
    for (const one of EQUIPMENT_ARTS) {
      const svg = equipmentArtSvg(one);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg.endsWith("</svg>")).toBe(true);
    }
  });

  /**
   * Every point the markup states in absolute terms: the corners of each
   * rect, the bounding box of each circle and ellipse, and the start of each
   * path. Relative path segments are not followed — this is a guard against a
   * mistyped coordinate, not an SVG interpreter.
   */
  function absolutePoints(svg: string): number[][] {
    const num = (v: string | undefined) => Number(v);
    const points: number[][] = [];

    for (const [, x, y, w, h] of svg.matchAll(
      /<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/g,
    )) {
      points.push([num(x), num(y)], [num(x) + num(w), num(y) + num(h)]);
    }
    for (const [, cx, cy, r] of svg.matchAll(
      /<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.-]+)"/g,
    )) {
      points.push([num(cx) - num(r), num(cy) - num(r)], [num(cx) + num(r), num(cy) + num(r)]);
    }
    for (const [, cx, cy, rx, ry] of svg.matchAll(
      /<ellipse cx="([\d.-]+)" cy="([\d.-]+)" rx="([\d.-]+)" ry="([\d.-]+)"/g,
    )) {
      points.push([num(cx) - num(rx), num(cy) - num(ry)], [num(cx) + num(rx), num(cy) + num(ry)]);
    }
    for (const [, x, y] of svg.matchAll(/[Mm] ?([\d.-]+)[ ,]([\d.-]+)/g)) {
      points.push([num(x), num(y)]);
    }

    return points;
  }

  it("draws inside the viewBox, so nothing is clipped at thumbnail size", () => {
    const escaping = EQUIPMENT_ARTS.flatMap((one) => {
      const points = absolutePoints(equipmentArtSvg(one));
      expect(points.length).toBeGreaterThan(0);

      return points
        .filter(([x, y]) => Math.min(x, y) < 0 || Math.max(x, y) > 64)
        .map(([x, y]) => `${one} (${x},${y})`);
    });

    expect(escaping).toEqual([]);
  });
});

describe("defaultEquipmentImage", () => {
  it("returns a data URI an <Image> can take", () => {
    const uri = defaultEquipmentImage("Treadmill", "Cardio");
    expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(uri.slice("data:image/svg+xml,".length))).toBe(
      equipmentArtSvg("treadmill"),
    );
  });

  it("escapes the characters that would end the URI early", () => {
    // Unescaped '#' truncates a data URI at the fragment; unescaped '<' and '"'
    // are invalid in one. Percent-encoding is what keeps the markup intact.
    const uri = defaultEquipmentImage("Treadmill", "Cardio");
    expect(uri).not.toMatch(/[#<>"]/);
  });

  it("gives two items with the same drawing the same URI", () => {
    expect(defaultEquipmentImage("Treadmill", "Cardio")).toBe(
      defaultEquipmentImage("Woodway Treadmill", "Other"),
    );
  });

  it("draws the pinned illustration when there is one", () => {
    expect(defaultEquipmentImage("Treadmill", "Cardio", "kettlebell")).toBe(
      equipmentArtImage("kettlebell"),
    );
  });
});

describe("equipmentArtImage", () => {
  it("gives every drawing a URI an <Image> can take", () => {
    for (const one of EQUIPMENT_ARTS) {
      const uri = equipmentArtImage(one);
      expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
      expect(uri).not.toMatch(/[#<>"]/);
    }
  });

  it("gives each drawing a URI of its own, so the picker shows sixteen tiles", () => {
    expect(new Set(EQUIPMENT_ARTS.map(equipmentArtImage)).size).toBe(EQUIPMENT_ARTS.length);
  });
});
