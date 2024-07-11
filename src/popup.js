const EXTENSION_STATUS = {
    DISABLED: 1,
    ENABLED: 2,
    RUNNING: 3
};

const inputEnabled = document.getElementById("enabled");

const updateStatus = (isEnabled) => {
    const newStatus = isEnabled ? EXTENSION_STATUS.ENABLED : EXTENSION_STATUS.DISABLED;

    chrome.storage.local.set({
        enabled: newStatus
    }, () => {
        chrome.runtime.sendMessage({
            action: "updateStatus",
            enabled: newStatus
        });

        chrome.tabs.query({
            active: true,
            currentWindow: true
        }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: "updateStatus",
                    enabled: newStatus
                });
            }
        });
    });
};

// Initialize
chrome.storage.local.get("enabled", (items) => {
    inputEnabled.checked = items.enabled > EXTENSION_STATUS.DISABLED;
});

// Event listener
inputEnabled.addEventListener('change', (event) => {
    updateStatus(event.target.checked);
});