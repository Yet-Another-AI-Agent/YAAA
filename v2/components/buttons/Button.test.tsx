// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { PrimaryButton, SecondaryButton } from "./Button";

describe("v2 buttons", () => {
  it("renders variants and forwards interactions", () => {
    const onClick = vi.fn();
    render(<><PrimaryButton onClick={onClick}>Accept</PrimaryButton><SecondaryButton>Cancel</SecondaryButton></>);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Accept" })).toHaveClass("v2-button-primary");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("v2-button-secondary");
  });
});
