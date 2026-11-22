import { BufferGeometry, Float32BufferAttribute, Group, Mesh } from "three";
import { describe, expect, it } from "vite-plus/test";
import { Rig, toBot, type PartInfo } from "./costume-rig.ts";

// Bot z from 6 to 6 + lift has no point in logo units, so these keep clear of it.
const POSITIONS = [0, 0, 0, 1, -2, 1.5, -3, 4, -3.9, 2, 1, 7.5, -1, 0, -9];

const PARTS: [string, PartInfo][] = [
  ["pivot at the head's center", { at: [0, 0, 0], origin: [0, 0, 0] }],
  ["pivot off center", { at: toBot([10, -20, 12]), origin: [10, -20, 12] }],
  ["uniform part", { at: toBot([5, 5, -45]), origin: [5, 5, -45], uniform: true }],
];

function rigged(info: PartInfo) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(POSITIONS, 3));
  const group = new Group();
  group.add(new Mesh(geometry));
  const rig = new Rig();
  rig.define("part", info);
  rig.attach("part", group);
  return { rig, geometry };
}

const positions = (geometry: BufferGeometry) => [...geometry.getAttribute("position").array];

describe("Rig.deform", () => {
  it.each(PARTS)("leaves a %s in place when nothing moves", (_, info) => {
    const { rig, geometry } = rigged(info);
    rig.deform("part", () => {});
    positions(geometry).forEach((value, i) => expect(value).toBeCloseTo(POSITIONS[i], 4));
  });
});

describe("Rig.reset", () => {
  it("drops spring state and restarts the time base while keeping attachments", () => {
    const { rig } = rigged(PARTS[0][1]);
    expect(rig.since(30)).toBe(0);
    expect(rig.since(30.5)).toBe(500);
    rig.state["flick"] = 1.5;
    rig.state["flick.v"] = 0.25;
    rig.state["flick.t"] = 500;

    rig.reset();

    expect(rig.state).toEqual({});
    // The clock starts again from the next frame asked.
    expect(rig.since(80)).toBe(0);
    expect(rig.since(81)).toBe(1000);
    // Part attachments survive a reset, so the remounted groups still pose.
    expect(rig.group("part")).toBeDefined();
  });
});
