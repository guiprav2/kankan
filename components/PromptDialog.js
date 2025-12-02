export default class PromptDialog {
  constructor(props = {}) {
    this.props = props;
    if (this.props.allowEmpty == null) this.props.allowEmpty = true;
    this.value = props.value ?? '';
    this.error = '';
  }
  get valid() {
    return this.props.allowEmpty || !!this.value?.trim?.();
  }
  close(value = 'cancel', detail) {
    let dialog = this.root?.parentElement;
    if (!dialog) return;
    if (detail !== undefined) dialog.returnDetail = detail;
    dialog.close(value);
  }
  cancel = () => this.close('cancel');
  handleKey = ev => {
    this.error = '';
    if (!ev) return;
    if (ev.key !== 'Enter' || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    this.submit(ev);
  };
  submit = ev => {
    ev?.preventDefault?.();
    this.error = '';
    if (!this.valid) {
      this.error = 'Value cannot be empty.';
      return;
    }
    this.close('ok', this.value);
  };
}
