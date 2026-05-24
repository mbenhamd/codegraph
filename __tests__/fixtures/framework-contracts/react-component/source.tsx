export function UserList() {
  const users = ['alice', 'bob'];
  return (
    <ul>
      {users.map((u) => (
        <li key={u}>{u}</li>
      ))}
    </ul>
  );
}
