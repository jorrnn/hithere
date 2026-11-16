
self.addEventListener("push", (event) => {
  let data = {};

  if (event.data) {
    try {
      data = event.data.json();
    } catch (error) {
      data = {
        title: "HiThere",
        body: event.data.text()
      };
    }
  }

  const title = data.title || data.sender_name || "HiThere";
  const options = {
    body: data.body || "You received a new message.",
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    data: {
      url: data.url || "/"
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }

      return clients.openWindow(url);
    })
  );
});
