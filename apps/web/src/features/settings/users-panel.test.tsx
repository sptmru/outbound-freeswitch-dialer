import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminOverviewResponse } from "../../types";
import { UsersPanel } from "./users-panel";

const apiMocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  fetchAdminUsers: vi.fn(),
  updateUser: vi.fn()
}));

vi.mock("../../api", () => apiMocks);

describe("UsersPanel", () => {
  const agent: AdminOverviewResponse["users"][number] = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "agent@example.com",
    name: "Agent One",
    role: "agent",
    isActive: true,
    agentRegistered: false,
    callerId: null
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchAdminUsers.mockResolvedValue({
      items: [agent],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1
    });
    apiMocks.updateUser.mockResolvedValue({ user: agent });
  });

  it("shows the default fallback and saves an agent Caller ID override", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<UsersPanel onChanged={onChanged} users={[agent]} />);

    expect(screen.getByText(/Caller ID default/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit user"));
    fireEvent.change(screen.getAllByLabelText("Caller ID")[1], { target: { value: " 15551112222 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(apiMocks.updateUser).toHaveBeenCalledWith(agent.id, {
        name: agent.name,
        email: agent.email,
        role: "agent",
        callerId: "15551112222"
      })
    );
    expect(onChanged).toHaveBeenCalled();
  });
});
