export default class ConfirmationDialog {
  constructor(props = {}) {
    this.props = props;
  }
  close(value = 'cancel') {
    let dialog = this.root?.parentElement;
    if (!dialog) return;
    dialog.close(value);
  }
  cancel = () => this.close('cancel');
  confirm = () => this.close('ok');
}
