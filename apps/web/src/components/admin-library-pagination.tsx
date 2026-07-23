export function AdminLibraryPagination({
  onPageChange,
  page,
  pending,
  totalPages
}: {
  onPageChange: (page: number) => void;
  page: number;
  pending: boolean;
  totalPages: number;
}) {
  return (
    <div className="pagination-controls">
      <button
        className="secondary-action compact-action"
        disabled={page <= 1 || pending}
        onClick={() => onPageChange(Math.max(1, page - 1))}
        type="button"
      >
        Previous
      </button>
      <span>
        Page {page} of {Math.max(totalPages, 1)}
      </span>
      <button
        className="secondary-action compact-action"
        disabled={page >= totalPages || pending}
        onClick={() => onPageChange(page + 1)}
        type="button"
      >
        Next
      </button>
    </div>
  );
}
