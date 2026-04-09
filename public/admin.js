async function loadInbox() {
  try {
    const res = await fetch('/admin/inbox');
    const data = await res.json();
    const tbody = document.querySelector('#inboxTable tbody');
    tbody.innerHTML = '';

    data.forEach(msg => {
      const tr = document.createElement('tr');

      // Highlight if subject or from matches filters
      const subjectLower = msg.subject.toLowerCase();
      const fromLower = msg.from.toLowerCase();
      const isFilterMatch = subjectLower.includes('otp') || subjectLower.includes('code') || fromLower.includes('noreply');

      if (isFilterMatch) tr.classList.add('filter-match');

      tr.innerHTML = `
        <td>${msg.user}</td>
        <td>${msg.email}</td>
        <td>${msg.from}</td>
        <td>${msg.subject}</td>
        <td>${msg.snippet}</td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error("Failed to load inbox:", err);
  }
}

// Initial load
loadInbox();

// Refresh every 5 seconds for new emails
setInterval(loadInbox, 5000);