let subscribed = false;

export function setFreeSwitchEventListenerSubscribed(value: boolean): void {
  subscribed = value;
}

export function isFreeSwitchEventListenerSubscribed(): boolean {
  return subscribed;
}
